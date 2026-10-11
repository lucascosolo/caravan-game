/**
 * The STANDING RAID PARTY — the passive side of the game (chunk 09; GUARDRAILS §0).
 *
 * A party is a TEMPLATE, not an expedition. Its owner configures it in town, leaves it
 * standing, and it is served as an encounter in OTHER players' trips while the owner is
 * away. It is never consumed, never loses a unit, never de-merges, however many fights it
 * appears in — exactly as a base's buildings survive being raided. The owner risks nothing.
 *
 * Two structures, deliberately split:
 *   - PartyConfig  — the owner's CHOICES: which roster instances ride (by instance id), each
 *                    one's targeting stance, approach edge and starting cell, and which siege
 *                    pieces come along (by type). This is what is stored. It carries no
 *                    stats, no HP and no merge level: those are facts of the roster, and
 *                    the config only REFERENCES the roster.
 *   - Party        — the config RESOLVED against the live roster and the unlock web: every
 *                    ref joined to its type and merge level, every cap and gate checked.
 *                    This is what is snapshotted into a job at commit (chunk 02) and what
 *                    the scouting view is built from. A party that no longer resolves (an
 *                    instance was lost on a trip or consumed by a merge) is INVALID until the
 *                    owner edits it — the fight never reached into the party; the roster
 *                    moved under it.
 *
 * Stances — exactly three, set here and never changed live (the owner is not present):
 *   - `nearest` — attack the nearest enemy thing (posted unit, fence segment in the way).
 *   - `traps`   — prioritize laid traps: spring them deliberately before the others walk in.
 *   - `core`    — beeline for the caravan core, ignoring what can be ignored.
 * These are the ATTACKING side's stances; the defending side's three live on the formation
 * (formation.ts) and are a different enum on purpose. Chunk 11 implements the behaviour.
 *
 * Approach: every unit picks an entry edge and a starting cell inside that edge's entry band
 * (the lattice's outermost ENTRY_BAND_DEPTH cells on that side — START_POSITION_BAND). A
 * party may split across all four edges. The cell is a lattice cell only; `cellCenter` turns
 * it into the tick-zero continuous position, exactly as it does for posts.
 *
 * Ordering is STABLE AND EXPLICIT: units are kept sorted by ref (instance id, code-unit
 * order) and siege by type id, so the same party serialises identically however it was
 * built and the resolver's tie-breaks see one order.
 *
 * Pure: no I/O, no clock, no randomness, no floats.
 */
import {
  FENCE_TIERS,
  TRAP_TYPES,
  TUNABLES,
  getSiegeType,
  getUnitType,
  mergeStatMult,
  scaleInt,
  type Ability,
  type AffinityCategory,
  type Fixed,
  type Millis,
  type SiegeCounter,
  type SiegeType,
} from "@caravan/content";
import { capIssues, issue, type Issue, type Validation } from "./issues.js";
import { ENTRY_EDGES, cellCenter, isCell, isEntryCell, isEntryEdge, type Cell, type EntryEdge, type FixedPoint } from "./lattice.js";
import type { AccessCheck } from "./manifest.js";

// ── stances ──────────────────────────────────────────────────────────────────────────

/** Fixed by design: exactly these three. */
export const TARGETING_STANCES = ["nearest", "traps", "core"] as const;
export type TargetingStance = (typeof TARGETING_STANCES)[number];

export function isTargetingStance(value: unknown): value is TargetingStance {
  return typeof value === "string" && (TARGETING_STANCES as readonly string[]).includes(value);
}

// ── caps (read from the registry, never inline) ───────────────────────────────────────

export const PARTY_SLOT_CAP: number = TUNABLES.PARTY_SLOT_CAP;
export const SIEGE_SLOT_CAP: number = TUNABLES.SIEGE_SLOT_CAP;
export const MAX_APPROACH_EDGES: number = TUNABLES.MAX_APPROACH_EDGES;
/** Always 0: editing is free and instant. Exported so the server can publish it, never gate on it. */
export const PARTY_EDIT_COOLDOWN_MS: number = TUNABLES.PARTY_EDIT_COOLDOWN_MS;

/**
 * Chunk 09 QA S1: the longest id (instance ref or content type id) a party may name. The
 * strict parser refuses anything longer; issue subjects are truncated to it; messages
 * never echo a raw id at all, so a hostile body cannot amplify itself through the
 * response. Real ids are uuids (36) or content ids (< 40).
 */
export const MAX_ID_LENGTH = 64;

/** An issue subject: the id, cut to MAX_ID_LENGTH. */
export function issueSubject(id: string): string {
  return id.length > MAX_ID_LENGTH ? id.slice(0, MAX_ID_LENGTH) : id;
}

// ── the config: the owner's choices ───────────────────────────────────────────────────

export interface PartyUnitConfig {
  /** A unit_instance id in the owner's roster. Unique within the party. */
  readonly ref: string;
  readonly stance: TargetingStance;
  readonly edge: EntryEdge;
  /** Starting cell: must lie in `edge`'s entry band. Two units may share a cell (units overlap freely). */
  readonly cell: Cell;
}

export interface PartyConfig {
  readonly v: 1;
  readonly units: readonly PartyUnitConfig[];
  /** Siege type ids. Each type at most once: a counter applies once, a second piece adds nothing. */
  readonly siege: readonly string[];
}

export const PARTY_CONFIG_VERSION = 1 as const;

export const EMPTY_PARTY_CONFIG: PartyConfig = Object.freeze({ v: PARTY_CONFIG_VERSION, units: Object.freeze([]), siege: Object.freeze([]) });

// ── the resolved party: what is served ────────────────────────────────────────────────

export interface PartyUnit extends PartyUnitConfig {
  readonly typeId: string;
  readonly mergeLevel: number;
}

export interface PartySiege {
  readonly typeId: string;
}

export interface Party {
  readonly v: 1;
  readonly units: readonly PartyUnit[];
  readonly siege: readonly PartySiege[];
}

export const PARTY_VERSION = 1 as const;

/** One living unit of the owner's roster, as the server reads it. The party only ever references these. */
export interface RosterUnit {
  readonly instanceId: string;
  readonly typeId: string;
  readonly mergeLevel: number;
}

// ── ordering ─────────────────────────────────────────────────────────────────────────

/** Code-unit string order: deterministic everywhere, unlike localeCompare. */
export function compareRefs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnits<T extends { readonly ref: string }>(units: readonly T[]): T[] {
  return [...units].sort((a, b) => compareRefs(a.ref, b.ref));
}

/** Canonical order: units by ref, siege by type id. Idempotent. */
export function normalizePartyConfig(c: PartyConfig): PartyConfig {
  return { v: c.v, units: sortedUnits(c.units).map((u) => ({ ref: u.ref, stance: u.stance, edge: u.edge, cell: { x: u.cell.x, y: u.cell.y } })), siege: [...c.siege].sort(compareRefs) };
}

export function normalizeParty(p: Party): Party {
  return {
    v: p.v,
    units: sortedUnits(p.units).map((u) => ({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, stance: u.stance, edge: u.edge, cell: { x: u.cell.x, y: u.cell.y } })),
    siege: [...p.siege].sort((a, b) => compareRefs(a.typeId, b.typeId)).map((s) => ({ typeId: s.typeId })),
  };
}

/** The distinct edges a party enters from, in ENTRY_EDGES order. */
export function partyEdges(p: { readonly units: readonly { readonly edge: EntryEdge }[] }): EntryEdge[] {
  const used = new Set(p.units.map((u) => u.edge));
  return ENTRY_EDGES.filter((e) => used.has(e));
}

// ── resolution: config + roster + access → party, or every issue at once ──────────────

/**
 * Hostile-size guard (chunk 07 QA S8's rule): a body with far more entries than any cap
 * allows is refused with one issue before per-entry work.
 */
export const PARTY_OVERSIZE_FACTOR = 4;

function oversizedIssue(c: PartyConfig): Issue | null {
  if (c.units.length > PARTY_SLOT_CAP * PARTY_OVERSIZE_FACTOR) return issue("oversized", `${c.units.length} units is far beyond the ${PARTY_SLOT_CAP}-unit cap`);
  if (c.siege.length > SIEGE_SLOT_CAP * PARTY_OVERSIZE_FACTOR) return issue("oversized", `${c.siege.length} siege pieces is far beyond the ${SIEGE_SLOT_CAP}-piece cap`);
  return null;
}

/**
 * Resolve the owner's choices against their roster and unlock web. Returns EVERY problem
 * at once (the builder shows all of them) or the canonical, deep-frozen party.
 *
 * Checks, in order per entry: ref is a roster instance (an instance lost on a trip or
 * consumed by a merge is simply not there any more → `unknown_ref`: the party is invalid
 * until edited, which is the structural guarantee that a FIGHT never reaches into a
 * party), no duplicate ref, type known and unlocked (the web is the only gate, GUARDRAILS
 * §3), merge level in range, stance in the enum, edge in the enum, cell on the lattice and
 * inside that edge's entry band. Siege: type known and unlocked, no duplicate type. Caps:
 * PARTY_SLOT_CAP living units (one slot per unit whatever its merge level — slot
 * efficiency IS the merge benefit) and SIEGE_SLOT_CAP pieces.
 *
 * An EMPTY party resolves fine: it is the state of every fresh account. Whether an empty
 * party is ever served is matchmaking's call (chunk 14), not a validity question.
 */
export function resolveParty(config: PartyConfig, roster: readonly RosterUnit[], isUnlocked: AccessCheck): Validation<Party> {
  const issues: Issue[] = [];
  if (config.v !== PARTY_CONFIG_VERSION) return { ok: false, issues: [issue("bad_version", `party config version ${String(config.v)} is not ${PARTY_CONFIG_VERSION}`)] };
  const oversized = oversizedIssue(config);
  if (oversized) return { ok: false, issues: [oversized] };

  if (config.units.length > PARTY_SLOT_CAP) issues.push(issue("slot_cap_units", `a party fields at most ${PARTY_SLOT_CAP} living units; ${config.units.length} chosen`));
  if (config.siege.length > SIEGE_SLOT_CAP) issues.push(issue("slot_cap_siege", `a party carries at most ${SIEGE_SLOT_CAP} siege pieces; ${config.siege.length} chosen`));

  const byInstance = new Map(roster.map((u) => [u.instanceId, u]));
  const seen = new Set<string>();
  const units: PartyUnit[] = [];
  for (const [i, u] of config.units.entries()) {
    if (typeof u.ref !== "string" || u.ref.length === 0) {
      issues.push(issue("unknown_ref", `party unit #${i} must name a roster instance`));
      continue;
    }
    // QA S1: messages name the entry by position, never by echoing the submitted id; the
    // (truncated) id rides in `subject` for the builder to match on.
    const subject = issueSubject(u.ref);
    if (seen.has(u.ref)) {
      issues.push(issue("duplicate_ref", `party unit #${i} is in the party twice`, subject));
      continue;
    }
    seen.add(u.ref);
    const live = byInstance.get(u.ref);
    if (!live) {
      issues.push(issue("unknown_ref", `party unit #${i} is not in your roster (it may have been lost on a trip or consumed by a merge)`, subject));
      continue;
    }
    const type = getUnitType(live.typeId);
    if (!type) {
      issues.push(issue("unknown_type", `party unit #${i} has an unknown living-unit type`, issueSubject(live.typeId)));
      continue;
    }
    if (!isUnlocked(live.typeId)) {
      issues.push(issue("type_locked", `party unit #${i}'s living-unit type is not unlocked`, issueSubject(live.typeId)));
      continue;
    }
    if (!Number.isInteger(live.mergeLevel) || live.mergeLevel < TUNABLES.MERGE_LEVEL_MIN || live.mergeLevel > TUNABLES.MERGE_LEVEL_MAX) {
      issues.push(issue("bad_merge_level", `party unit #${i}'s merge level ${String(live.mergeLevel)} is outside ${TUNABLES.MERGE_LEVEL_MIN}..${TUNABLES.MERGE_LEVEL_MAX}`, subject));
      continue;
    }
    let bad = false;
    if (!isTargetingStance(u.stance)) {
      issues.push(issue("bad_stance", `party unit #${i}: stance must be one of ${TARGETING_STANCES.join(", ")}`, subject));
      bad = true;
    }
    if (!isEntryEdge(u.edge)) {
      issues.push(issue("bad_edge", `party unit #${i}: approach edge must be one of ${ENTRY_EDGES.join(", ")}`, subject));
      bad = true;
    } else if (!isCell(u.cell)) {
      issues.push(issue("bad_cell", `party unit #${i}: starting cell must be a lattice cell`, subject));
      bad = true;
    } else if (!isEntryCell(u.cell, u.edge)) {
      issues.push(issue("cell_off_band", `party unit #${i}: starting cell (${u.cell.x}, ${u.cell.y}) is not in the ${u.edge} entry band`, subject));
      bad = true;
    }
    if (bad) continue;
    units.push({ ref: u.ref, typeId: live.typeId, mergeLevel: live.mergeLevel, stance: u.stance, edge: u.edge, cell: { x: u.cell.x, y: u.cell.y } });
  }

  const seenSiege = new Set<string>();
  const siege: PartySiege[] = [];
  for (const [i, typeId] of config.siege.entries()) {
    const subject = issueSubject(String(typeId));
    if (!getSiegeType(typeId)) {
      issues.push(issue("unknown_type", `party siege #${i} is an unknown siege type`, subject));
      continue;
    }
    if (seenSiege.has(typeId)) {
      issues.push(issue("duplicate_siege", `party siege #${i} is in the party twice; a counter applies once`, subject));
      continue;
    }
    seenSiege.add(typeId);
    if (!isUnlocked(typeId)) {
      issues.push(issue("type_locked", `party siege #${i} is not unlocked`, subject));
      continue;
    }
    siege.push({ typeId });
  }

  if (issues.length > 0) return { ok: false, issues: capIssues(issues) };
  return { ok: true, value: freezeParty(normalizeParty({ v: PARTY_VERSION, units, siege })) };
}

export function freezeParty(p: Party): Party {
  for (const u of p.units) {
    Object.freeze(u.cell);
    Object.freeze(u);
  }
  for (const s of p.siege) Object.freeze(s);
  Object.freeze(p.units);
  Object.freeze(p.siege);
  return Object.freeze(p);
}

/** Structural check for a resolved party that came back from storage (a snapshot). Throws: a bad stored party is a bug. */
export function assertParty(p: Party): void {
  const fail = (why: string): never => {
    throw new TypeError(`malformed party: ${why}`);
  };
  if (p.v !== PARTY_VERSION) fail(`version ${String(p.v)}`);
  if (p.units.length > PARTY_SLOT_CAP) fail(`${p.units.length} units over the cap`);
  if (p.siege.length > SIEGE_SLOT_CAP) fail(`${p.siege.length} siege over the cap`);
  const refs = new Set<string>();
  for (const u of p.units) {
    if (typeof u.ref !== "string" || u.ref.length === 0) fail("empty ref");
    if (u.ref.length > MAX_ID_LENGTH) fail(`ref longer than ${MAX_ID_LENGTH}`);
    if (refs.has(u.ref)) fail(`duplicate ref ${u.ref}`);
    refs.add(u.ref);
    if (!getUnitType(u.typeId)) fail(`unknown unit type ${issueSubject(u.typeId)}`);
    if (!Number.isInteger(u.mergeLevel) || u.mergeLevel < TUNABLES.MERGE_LEVEL_MIN || u.mergeLevel > TUNABLES.MERGE_LEVEL_MAX) fail(`merge level ${String(u.mergeLevel)}`);
    if (!isTargetingStance(u.stance)) fail(`stance ${String(u.stance)}`);
    if (!isEntryEdge(u.edge)) fail(`edge ${String(u.edge)}`);
    if (!isCell(u.cell) || !isEntryCell(u.cell, u.edge)) fail(`unit ${u.ref} cell is off its entry band`);
  }
  const types = new Set<string>();
  for (const s of p.siege) {
    if (!getSiegeType(s.typeId)) fail(`unknown siege type ${issueSubject(s.typeId)}`);
    if (types.has(s.typeId)) fail(`duplicate siege ${s.typeId}`);
    types.add(s.typeId);
  }
}

// ── the scouting view: EXACTLY what a defender sees, and exactly what the owner previews ──

/**
 * Everything about one party unit a defender needs to counter it (GUARDRAILS §4). Both
 * ratings are shown; `ratingInUse` says which one this side fights with. There is no
 * blended power number anywhere.
 */
export interface ScoutUnit {
  readonly ref: string;
  readonly typeId: string;
  readonly displayName: string;
  readonly affinity: AffinityCategory;
  readonly mergeLevel: number;
  /** Always 1: a merged unit is slot-efficient, never slot-expensive. */
  readonly slotCost: 1;
  readonly stance: TargetingStance;
  readonly edge: EntryEdge;
  readonly cell: Cell;
  /** Tick-zero position (cellCenter). */
  readonly pos: FixedPoint;
  readonly ratingInUse: "offense";
  /** The rating a raider fights with. Unmerged type value: merge never scales ratings (chunk 03 QA B1). */
  readonly offense: number;
  /** Shown for comparison only — this side never uses it. */
  readonly defense: number;
  /** Max HP at this merge level. */
  readonly hp: number;
  /**
   * The multiplier on every hit this unit lands, at this merge level (MERGE_STAT_MULT_BY_LEVEL;
   * the resolver's DAMAGE_ROUNDING_ORDER step 3). Merge scales HP and damage OUTPUT, never a
   * rating, so the scout shows it beside the unscaled offense (chunk 08 QA S1).
   */
  readonly damagePerHitMult: Fixed;
  readonly moveSpeed: Fixed;
  readonly attackRange: Fixed;
  readonly attackCooldown: Millis;
  readonly ability: Ability;
}

/** A siege piece with its counter spelled out: what it counters and which content types that is. */
export interface ScoutSiege {
  readonly typeId: string;
  readonly displayName: string;
  readonly counters: SiegeCounter;
  /** `accelerates` fence breaking (×SIEGE_FENCE_DAMAGE_MULT) or `bypasses` a trap category (nullified; still spent). */
  readonly effect: "accelerates" | "bypasses";
  readonly fenceDamageMult: Fixed | null;
  readonly nullifiesTrap: boolean;
  /** The fence tier ids or trap type ids in the countered category. */
  readonly targetTypeIds: readonly string[];
}

export interface PartyScoutView {
  readonly v: 1;
  readonly units: readonly ScoutUnit[];
  readonly siege: readonly ScoutSiege[];
  readonly edges: readonly EntryEdge[];
  readonly unitSlots: { readonly used: number; readonly cap: number };
  readonly siegeSlots: { readonly used: number; readonly cap: number };
}

export const SCOUT_VIEW_VERSION = 1 as const;

export function siegeCounterEntry(type: SiegeType): ScoutSiege {
  const c = type.counters;
  const targetTypeIds = c.kind === "fence" ? FENCE_TIERS.filter((f) => f.category === c.category).map((f) => f.id) : TRAP_TYPES.filter((t) => t.category === c.category).map((t) => t.id);
  return {
    typeId: type.id,
    displayName: type.displayName,
    counters: { kind: c.kind, category: c.category } as SiegeCounter,
    effect: c.kind === "fence" ? "accelerates" : "bypasses",
    fenceDamageMult: c.kind === "fence" ? TUNABLES.SIEGE_FENCE_DAMAGE_MULT : null,
    nullifiesTrap: c.kind === "trap" ? TUNABLES.SIEGE_TRAP_NULLIFY : false,
    targetTypeIds,
  };
}

export function scoutUnit(u: PartyUnit): ScoutUnit {
  const type = getUnitType(u.typeId);
  if (!type) throw new TypeError(`scoutUnit: unknown unit type ${u.typeId}`);
  return {
    ref: u.ref,
    typeId: u.typeId,
    displayName: type.displayName,
    affinity: type.affinity,
    mergeLevel: u.mergeLevel,
    slotCost: 1,
    stance: u.stance,
    edge: u.edge,
    cell: { x: u.cell.x, y: u.cell.y },
    pos: cellCenter(u.cell),
    ratingInUse: "offense",
    offense: type.offense,
    defense: type.defense,
    hp: scaleInt(type.hp, mergeStatMult(u.mergeLevel)),
    damagePerHitMult: mergeStatMult(u.mergeLevel),
    moveSpeed: type.moveSpeed,
    attackRange: type.attackRange,
    attackCooldown: type.attackCooldown,
    ability: type.ability,
  };
}

/**
 * THE scouting view. One function, used by the owner's preview (chunk 09) and by the
 * defender's scout (chunk 14) alike, so the two can never disagree: there is no second
 * code path that could hide a field from one side.
 */
export function scoutParty(party: Party): PartyScoutView {
  const p = normalizeParty(party);
  return {
    v: SCOUT_VIEW_VERSION,
    units: p.units.map(scoutUnit),
    siege: p.siege.map((s) => {
      const type = getSiegeType(s.typeId);
      if (!type) throw new TypeError(`scoutParty: unknown siege type ${s.typeId}`);
      return siegeCounterEntry(type);
    }),
    edges: partyEdges(p),
    unitSlots: { used: p.units.length, cap: PARTY_SLOT_CAP },
    siegeSlots: { used: p.siege.length, cap: SIEGE_SLOT_CAP },
  };
}

// ── registry coherence (import-time, like lattice.ts) ──────────────────────────────────
(() => {
  const fail = (why: string): never => {
    throw new Error(`party tunables are incoherent: ${why}`);
  };
  if (MAX_APPROACH_EDGES !== ENTRY_EDGES.length) fail(`MAX_APPROACH_EDGES ${MAX_APPROACH_EDGES} != ${ENTRY_EDGES.length} entry edges`);
  if (PARTY_EDIT_COOLDOWN_MS !== 0) fail(`PARTY_EDIT_COOLDOWN_MS must be 0 — editing is free and instant by design`);
  if (!Number.isInteger(PARTY_SLOT_CAP) || PARTY_SLOT_CAP < 1) fail(`PARTY_SLOT_CAP ${PARTY_SLOT_CAP}`);
  if (!Number.isInteger(SIEGE_SLOT_CAP) || SIEGE_SLOT_CAP < 0) fail(`SIEGE_SLOT_CAP ${SIEGE_SLOT_CAP}`);
  if (TUNABLES.PARTIES_PER_ACCOUNT < 1) fail(`PARTIES_PER_ACCOUNT ${TUNABLES.PARTIES_PER_ACCOUNT}`);
})();
