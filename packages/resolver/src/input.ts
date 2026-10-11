/**
 * The resolver's input contract (chunk 10). `resolve(input)` takes exactly three things
 * and nothing else: the battlefield (the wagon circle as arranged — battlefield.ts), the
 * attacking party (a standing-party snapshot, chunk 09), and the tunables it needs. No
 * account, Coin, purchase or entitlement state has a field here, and `assertResolveInput`
 * refuses unknown keys at every level by name, so none can arrive through data either
 * (GUARDRAILS §2).
 *
 * ORDERING IS NORMALIZED ON ENTRY (chunk 10 DoD, "shuffled-input test"): the arrays in the
 * input may arrive in any order; `normalizeInput` sorts attackers, posts, traps and siege
 * by ref (plain code-unit string order) and fences by ring segment, and REFUSES duplicate
 * refs. Unit ids (the tie-break ordering used everywhere in the simulation) are assigned
 * from that sorted order, so a reordered input produces a byte-identical output.
 *
 * Tunables arrive as plain integers. The values are authored in @caravan/content's
 * registry; @caravan/circle's `resolverTunables()` builds this object from it. The resolver
 * never reads the registry.
 */
import {
  ABILITY_ARCHETYPES,
  AFFINITY_CATEGORIES,
  BATTLEFIELD_KEYS,
  FENCE_CATEGORIES,
  GRID_HEIGHT,
  GRID_WIDTH,
  RING_ANCHORS,
  RING_SEGMENTS,
  TRAP_CATEGORIES,
  assertBattlefield,
  assertCell,
  assertIntegersOnly,
  eachOf,
  isEntryCell,
  isEntryEdge,
  isInBounds,
  isAnchorCell,
  isRingCell,
  onlyKeys,
  ringIndexAt,
  sameCell,
  type Ability,
  type AffinityCategory,
  type Battlefield,
  type Cell,
  type EntryEdge,
  type FenceCategory,
  type Fixed,
  type Millis,
  type TrapCategory,
} from "./battlefield.js";

/** The three targeting stances (chunk 09 STANCES). Fixed by design — exactly these. */
export const STANCES = ["nearest", "traps", "core"] as const;
export type Stance = (typeof STANCES)[number];

export function isStance(value: unknown): value is Stance {
  return typeof value === "string" && (STANCES as readonly string[]).includes(value);
}

/** What a siege piece counters — mirrors content's SiegeCounter structurally. */
export type SiegeCounter =
  | { readonly kind: "fence"; readonly category: FenceCategory }
  | { readonly kind: "trap"; readonly category: TrapCategory };

export interface PartyUnit {
  /** Unique within the party. Sorted on entry; assigns the unit id. */
  readonly ref: string;
  readonly typeId: string;
  readonly mergeLevel: number;
  readonly stance: Stance;
  /** The edge the unit approaches from and its lattice start cell, inside that edge's entry band. */
  readonly entry: { readonly edge: EntryEdge; readonly cell: Cell };
  /** Current and max HP (max already scaled by merge level, like a posted unit's). */
  readonly hp: number;
  readonly maxHp: number;
  readonly affinity: AffinityCategory;
  /** The OFFENSE rating — an attacker never uses defense (chunk 11 slot rule). */
  readonly offense: number;
  readonly moveSpeed: Fixed;
  readonly attackRange: Fixed;
  readonly attackCooldown: Millis;
  readonly ability: Ability;
}

export interface PartySiege {
  readonly ref: string;
  readonly typeId: string;
  readonly counters: SiegeCounter;
}

/** A standing party as served into one encounter. A template: the resolver never writes to it. */
export interface Party {
  readonly v: 1;
  readonly units: readonly PartyUnit[];
  readonly siege: readonly PartySiege[];
}

export const PARTY_VERSION = 1 as const;

/**
 * The tunables chunk 10 consumes, as plain integers. Defaults (chunk 10 brief) are in
 * @caravan/content's registry: TICK_RATE 20, BATTLE_LENGTH_CAP_SECONDS 180,
 * PATH_RECOMPUTE_INTERVAL 500 ms (= 10 ticks), UNIT_RADIUS 0.35 cells,
 * LOG_KEYFRAME_INTERVAL 5 s (= 100 ticks). Durations arrive in MILLISECONDS, like every
 * duration content authors, and are converted to ticks once at setup
 * (floor(ms × tickRate / 1000), minimum 1) — the registry never encodes ticks.
 */
export interface ResolverTunables {
  /** Ticks per second. TICK_CAP is derived: battleLengthCapSeconds × tickRate. */
  readonly tickRate: number;
  readonly battleLengthCapSeconds: number;
  /** Paths are recomputed every this many ms (and on target change / fence break). */
  readonly pathRecomputeIntervalMs: Millis;
  /** Fixed cells. Used for range/radius checks by chunks 11–12, never for collision. */
  readonly unitRadius: Fixed;
  /** A full-state keyframe is logged every this many ms (chunk 13 seeks on these). */
  readonly keyframeIntervalMs: Millis;
  /**
   * PATH_CONNECTIVITY (chunk 07 QA decision): the lattice graph is 4-connected — no
   * diagonal moves, no corner cutting. Fixed by design in this resolver version; only the
   * value 4 is accepted, and it is carried as input so the choice is explicit in every
   * stored input snapshot.
   */
  readonly pathConnectivity: 4;
}

export interface ResolveInput {
  readonly battlefield: Battlefield;
  readonly party: Party;
  readonly tunables: ResolverTunables;
}

export class ResolverInputError extends Error {
  constructor(message: string) {
    super(`resolver input refused: ${message}`);
    this.name = "ResolverInputError";
  }
}

const fail = (m: string): never => {
  throw new ResolverInputError(m);
};

const INPUT_KEYS = {
  input: ["battlefield", "party", "tunables"],
  party: ["v", "units", "siege"],
  unit: ["ref", "typeId", "mergeLevel", "stance", "entry", "hp", "maxHp", "affinity", "offense", "moveSpeed", "attackRange", "attackCooldown", "ability"],
  entry: ["edge", "cell"],
  siege: ["ref", "typeId", "counters"],
  counters: ["kind", "category"],
  tunables: ["tickRate", "battleLengthCapSeconds", "pathRecomputeIntervalMs", "unitRadius", "keyframeIntervalMs", "pathConnectivity"],
  abilityBase: ["archetype", "displayName", "description", "cooldown"],
} as const;

const ABILITY_EXTRA_KEYS: Readonly<Record<string, readonly string[]>> = {
  burst_radius: ["radius", "damageMult"],
  heavy_strike: ["damageMult"],
  heal_radius: ["radius", "healFraction", "charges"],
  self_buff: ["damageBonus", "duration"],
  dash: ["distance"],
  structure_breaker: ["fenceDamageMult"],
};

function positiveInt(v: unknown, where: string, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) fail(`${where} must be an integer ≥ ${min}`);
  return v as number;
}

function nonEmptyString(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) fail(`${where} must be a non-empty string`);
  return v as string;
}

function oneOf(v: unknown, where: string, allowed: readonly string[]): void {
  if (typeof v !== "string" || !allowed.includes(v)) fail(`${where} must be one of ${allowed.join(", ")}`);
}

function assertAbility(v: unknown, where: string): void {
  const base = onlyKeys(v, where, [...INPUT_KEYS.abilityBase, ...(ABILITY_EXTRA_KEYS[typeof (v as { archetype?: unknown })?.archetype === "string" ? ((v as { archetype: string }).archetype) : ""] ?? [])], fail);
  oneOf(base.archetype, `${where}.archetype`, ABILITY_ARCHETYPES);
  nonEmptyString(base.displayName, `${where}.displayName`);
  if (typeof base.description !== "string") fail(`${where}.description must be a string`);
  positiveInt(base.cooldown, `${where}.cooldown`, 1);
  for (const k of ABILITY_EXTRA_KEYS[base.archetype as string] ?? []) positiveInt(base[k], `${where}.${k}`, 0);
}

/** Throws unless `v` is exactly a Party: closed keys, valid stances, entry cells in their bands. */
export function assertParty(v: unknown): asserts v is Party {
  const p = onlyKeys(v, "party", INPUT_KEYS.party, fail);
  if (p.v !== PARTY_VERSION) fail(`party version ${String(p.v)}`);
  const units = eachOf(p.units, "party.units", fail);
  if (units.length === 0) fail("party.units must not be empty");
  units.forEach((u, i) => {
    const where = `party.units[${i}]`;
    const o = onlyKeys(u, where, INPUT_KEYS.unit, fail);
    nonEmptyString(o.ref, `${where}.ref`);
    nonEmptyString(o.typeId, `${where}.typeId`);
    positiveInt(o.mergeLevel, `${where}.mergeLevel`, 1);
    if (!isStance(o.stance)) fail(`${where}.stance must be one of ${STANCES.join(", ")}`);
    const entry = onlyKeys(o.entry, `${where}.entry`, INPUT_KEYS.entry, fail);
    if (!isEntryEdge(entry.edge)) fail(`${where}.entry.edge is not an edge`);
    assertCell(entry.cell, `${where}.entry.cell`, fail);
    if (!isEntryCell(entry.cell as Cell, entry.edge as EntryEdge)) fail(`${where}.entry.cell is outside the ${String(entry.edge)} entry band`);
    const hp = positiveInt(o.hp, `${where}.hp`, 1);
    const maxHp = positiveInt(o.maxHp, `${where}.maxHp`, 1);
    if (hp > maxHp) fail(`${where}.hp exceeds maxHp`);
    oneOf(o.affinity, `${where}.affinity`, AFFINITY_CATEGORIES);
    positiveInt(o.offense, `${where}.offense`, 1);
    positiveInt(o.moveSpeed, `${where}.moveSpeed`, 0);
    positiveInt(o.attackRange, `${where}.attackRange`, 0);
    positiveInt(o.attackCooldown, `${where}.attackCooldown`, 1);
    assertAbility(o.ability, `${where}.ability`);
  });
  eachOf(p.siege, "party.siege", fail).forEach((s, i) => {
    const where = `party.siege[${i}]`;
    const o = onlyKeys(s, where, INPUT_KEYS.siege, fail);
    nonEmptyString(o.ref, `${where}.ref`);
    nonEmptyString(o.typeId, `${where}.typeId`);
    const c = onlyKeys(o.counters, `${where}.counters`, INPUT_KEYS.counters, fail);
    if (c.kind === "fence") oneOf(c.category, `${where}.counters.category`, FENCE_CATEGORIES);
    else if (c.kind === "trap") oneOf(c.category, `${where}.counters.category`, TRAP_CATEGORIES);
    else fail(`${where}.counters.kind must be fence or trap`);
  });
  assertIntegersOnly(v, "party", fail);
}

export function assertTunables(v: unknown): asserts v is ResolverTunables {
  const t = onlyKeys(v, "tunables", INPUT_KEYS.tunables, fail);
  positiveInt(t.tickRate, "tunables.tickRate", 1);
  positiveInt(t.battleLengthCapSeconds, "tunables.battleLengthCapSeconds", 1);
  positiveInt(t.pathRecomputeIntervalMs, "tunables.pathRecomputeIntervalMs", 1);
  positiveInt(t.unitRadius, "tunables.unitRadius", 0);
  positiveInt(t.keyframeIntervalMs, "tunables.keyframeIntervalMs", 1);
  if (t.pathConnectivity !== 4) fail("tunables.pathConnectivity must be 4 (4-connected lattice, no diagonals; fixed by design)");
}

/**
 * Full input validation: shape of all three parts, then the cross-checks the shape guards
 * cannot see — grid size matches the lattice, fences sit on ring cells at their own
 * segment, unique refs, posts and traps off the fences, hp bounds.
 */
export function assertResolveInput(v: unknown): asserts v is ResolveInput {
  const i = onlyKeys(v, "input", INPUT_KEYS.input, fail);
  try {
    assertBattlefield(i.battlefield);
  } catch (e) {
    fail(e instanceof Error ? e.message : "battlefield");
  }
  assertParty(i.party);
  assertTunables(i.tunables);
  const b = i.battlefield as Battlefield;
  if (b.grid.width !== GRID_WIDTH || b.grid.height !== GRID_HEIGHT) fail(`battlefield grid ${b.grid.width}×${b.grid.height} is not the ${GRID_WIDTH}×${GRID_HEIGHT} lattice`);
  // The anchors are the four ring corners, exactly, in RING_ANCHORS order: the geometry
  // is the resolver's, the input only confirms it (a replay must mean the same thing).
  if (b.anchors.length !== RING_ANCHORS.length || b.anchors.some((c, k) => !sameCell(c, RING_ANCHORS[k]!))) {
    fail(`battlefield.anchors must be exactly the ${RING_ANCHORS.length} ring corners in order`);
  }
  const refs: string[] = [];
  const takenCells: Cell[] = [];
  b.fences.forEach((f, idx) => {
    const seg = RING_SEGMENTS[f.segment];
    if (!seg) fail(`fences[${idx}].segment ${f.segment} is not a ring segment`);
    if (!sameCell(seg!.cell, f.cell)) fail(`fences[${idx}].cell is not segment ${f.segment}'s cell`);
    if (f.hp < 0 || f.maxHp < 1 || f.hp > f.maxHp) fail(`fences[${idx}] hp ${f.hp}/${f.maxHp} out of range`);
    oneOf(f.category, `fences[${idx}].category`, FENCE_CATEGORIES);
    if (refs.includes(f.ref)) fail(`duplicate fence ref '${f.ref}'`);
    refs.push(f.ref);
    if (takenCells.some((c) => sameCell(c, f.cell))) fail(`two fences on segment ${f.segment}`);
    takenCells.push(f.cell);
  });
  const trapRefs: string[] = [];
  b.traps.forEach((t, idx) => {
    if (!isInBounds(t.cell) || isRingCell(t.cell) || isAnchorCell(t.cell)) fail(`traps[${idx}].cell is on the ring, an anchor, or off the lattice`);
    if (trapRefs.includes(t.ref)) fail(`duplicate trap ref '${t.ref}'`);
    trapRefs.push(t.ref);
    oneOf(t.category, `traps[${idx}].category`, TRAP_CATEGORIES);
    oneOf(t.affinity, `traps[${idx}].affinity`, AFFINITY_CATEGORIES);
  });
  const postRefs: string[] = [];
  b.posts.forEach((p, idx) => {
    if (!isInBounds(p.cell) || isRingCell(p.cell) || isAnchorCell(p.cell)) fail(`posts[${idx}].cell is on the ring, an anchor, or off the lattice`);
    if (p.hp < 1 || p.hp > p.maxHp) fail(`posts[${idx}] hp ${p.hp}/${p.maxHp} out of range (dead units are not posted)`);
    if (p.defense < 1) fail(`posts[${idx}].defense must be ≥ 1`);
    if (postRefs.includes(p.ref)) fail(`duplicate post ref '${p.ref}'`);
    postRefs.push(p.ref);
    oneOf(p.affinity, `posts[${idx}].affinity`, AFFINITY_CATEGORIES);
    assertAbility(p.ability, `posts[${idx}].ability`);
  });
  const unitRefs: string[] = [];
  (i.party as Party).units.forEach((u, idx) => {
    if (unitRefs.includes(u.ref)) fail(`duplicate party unit ref '${u.ref}'`);
    unitRefs.push(u.ref);
    if (ringIndexAt(u.entry.cell) !== null) fail(`party.units[${idx}] starts on the ring`);
  });
  const siegeRefs: string[] = [];
  (i.party as Party).siege.forEach((s) => {
    if (siegeRefs.includes(s.ref)) fail(`duplicate siege ref '${s.ref}'`);
    siegeRefs.push(s.ref);
  });
  // Unused-but-documented: BATTLEFIELD_KEYS is the closed key set the battlefield guard uses.
  void BATTLEFIELD_KEYS;
}

/** Plain code-unit string order: a total order on refs, independent of locale. */
export function compareRefs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical ordering of every input array (see header). Returns a new input; never
 * mutates the caller's. Validation must already have passed.
 */
export function normalizeInput(input: ResolveInput): ResolveInput {
  const byRef = <T extends { readonly ref: string }>(a: T, b: T) => compareRefs(a.ref, b.ref);
  return {
    battlefield: {
      v: input.battlefield.v,
      grid: { width: input.battlefield.grid.width, height: input.battlefield.grid.height },
      core: { cells: [...input.battlefield.core.cells], center: input.battlefield.core.center },
      anchors: [...input.battlefield.anchors],
      entries: [...input.battlefield.entries],
      fences: [...input.battlefield.fences].sort((a, b) => a.segment - b.segment),
      traps: [...input.battlefield.traps].sort(byRef),
      posts: [...input.battlefield.posts].sort(byRef),
    },
    party: {
      v: input.party.v,
      units: [...input.party.units].sort(byRef),
      siege: [...input.party.siege].sort(byRef),
    },
    tunables: {
      tickRate: input.tunables.tickRate,
      battleLengthCapSeconds: input.tunables.battleLengthCapSeconds,
      pathRecomputeIntervalMs: input.tunables.pathRecomputeIntervalMs,
      unitRadius: input.tunables.unitRadius,
      keyframeIntervalMs: input.tunables.keyframeIntervalMs,
      pathConnectivity: input.tunables.pathConnectivity,
    },
  };
}
