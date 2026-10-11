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
  cellOf,
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
import { FIXED_POINT_SCALE } from "./fixed.js";

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
 * Magnitude bounds on everything the simulation multiplies together (QA-10 S3/S4). These
 * are VALIDATION limits, not balance: within them hits × cooldownTicks × speedPerTick
 * (≤ 10⁶ × (60 000 ms × 1000 ticks/s / 1000) × 65 536 ≈ 3.9·10¹⁵ < 2⁵³), every squared
 * distance and every tick count stays a safe integer, so the breach-edge clamp (path.ts
 * BREACH_COST_MAX) is the only saturation in the resolver. Content's values sit orders of
 * magnitude below them. A test pins the worst-case product as a safe integer.
 */
export const INPUT_BOUNDS = {
  /** hp / maxHp of units, posts and fence segments. */
  maxHp: 1_000_000,
  /** offense, defense, trap damage. */
  maxRating: 1_000_000,
  /** Fixed cells per second: 64 cells/s, twice the field per second. */
  maxMoveSpeed: 64 * FIXED_POINT_SCALE,
  /** Fixed cells: ranges, radii, dash distance — twice the field. */
  maxDistance: 64 * FIXED_POINT_SCALE,
  /** Any duration in ms: cooldowns, intervals. One minute. */
  maxMillis: 60_000,
  maxTickRate: 1000,
  /** battleLengthCapSeconds: one hour. */
  maxBattleSeconds: 3600,
  /** Any fixed-point multiplier (affinity, merge, siege): ×64. */
  maxMult: 64 * FIXED_POINT_SCALE,
  /** Highest merge level mergeStatMultByLevel may index. */
  maxMergeLevels: 16,
} as const;

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

  // ── Chunk 11 — combat. Defaults in @caravan/content's registry; all TUNABLE there. ──
  /** AFFINITY_ADVANTAGE_MULT (×1.25 = 1280), applied to a hit AFTER the damage formula, floored. */
  readonly affinityAdvantageMult: Fixed;
  /** AFFINITY_DISADVANTAGE_MULT (×0.80 = 819). */
  readonly affinityDisadvantageMult: Fixed;
  /** AFFINITY_NEUTRAL_MULT (×1.0 = 1024): the identity, carried so no multiplier is implicit. */
  readonly affinityNeutralMult: Fixed;
  /**
   * AFFINITY_MATRIX[dealer][receiver] — the relationships, as data (content's affinity.ts).
   * Complete: every ordered pair of the three categories. Traps deal damage of their own
   * affinity through the same matrix.
   */
  readonly affinityMatrix: AffinityMatrix;
  /**
   * MERGE_STAT_MULT_BY_LEVEL, indexed by merge level (index 0 unused). Chunk 03 QA B1: the
   * multiplier applies to max HP (already in the input's `maxHp`) and to each hit's damage
   * output AFTER the formula — never to the offense/defense ratings that enter it, never to
   * an ability field. Every unit's mergeLevel must index this table.
   */
  readonly mergeStatMultByLevel: readonly Fixed[];
  /** TRAP_TRIGGER_RADIUS (0.75 cells): a trap fires when a swept path comes within this + unitRadius of its centre. */
  readonly trapTriggerRadius: Fixed;
  /** SIEGE_FENCE_DAMAGE_MULT (×4): a party carrying siege that counters a fence category hits those segments this much harder. */
  readonly siegeFenceDamageMult: Fixed;
  /**
   * LEASH_HYSTERESIS (×0.80 = 819): a returning posted unit may re-acquire only once it is
   * back within this fraction of its leash distance from its post.
   */
  readonly leashHysteresisMult: Fixed;
}

export const AFFINITY_OUTCOMES = ["advantage", "neutral", "disadvantage"] as const;
export type AffinityOutcome = (typeof AFFINITY_OUTCOMES)[number];
export type AffinityMatrix = Readonly<Record<AffinityCategory, Readonly<Record<AffinityCategory, AffinityOutcome>>>>;

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
  tunables: [
    "tickRate",
    "battleLengthCapSeconds",
    "pathRecomputeIntervalMs",
    "unitRadius",
    "keyframeIntervalMs",
    "pathConnectivity",
    "affinityAdvantageMult",
    "affinityDisadvantageMult",
    "affinityNeutralMult",
    "affinityMatrix",
    "mergeStatMultByLevel",
    "trapTriggerRadius",
    "siegeFenceDamageMult",
    "leashHysteresisMult",
  ],
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

function boundedInt(v: unknown, where: string, min: number, max: number): number {
  const n = positiveInt(v, where, min);
  if (n > max) fail(`${where} must be ≤ ${max}`);
  return n;
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
  boundedInt(base.cooldown, `${where}.cooldown`, 1, INPUT_BOUNDS.maxMillis);
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
    const hp = boundedInt(o.hp, `${where}.hp`, 1, INPUT_BOUNDS.maxHp);
    const maxHp = boundedInt(o.maxHp, `${where}.maxHp`, 1, INPUT_BOUNDS.maxHp);
    if (hp > maxHp) fail(`${where}.hp exceeds maxHp`);
    oneOf(o.affinity, `${where}.affinity`, AFFINITY_CATEGORIES);
    boundedInt(o.offense, `${where}.offense`, 1, INPUT_BOUNDS.maxRating);
    boundedInt(o.moveSpeed, `${where}.moveSpeed`, 1, INPUT_BOUNDS.maxMoveSpeed);
    boundedInt(o.attackRange, `${where}.attackRange`, 0, INPUT_BOUNDS.maxDistance);
    boundedInt(o.attackCooldown, `${where}.attackCooldown`, 1, INPUT_BOUNDS.maxMillis);
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
  boundedInt(t.tickRate, "tunables.tickRate", 1, INPUT_BOUNDS.maxTickRate);
  boundedInt(t.battleLengthCapSeconds, "tunables.battleLengthCapSeconds", 1, INPUT_BOUNDS.maxBattleSeconds);
  boundedInt(t.pathRecomputeIntervalMs, "tunables.pathRecomputeIntervalMs", 1, INPUT_BOUNDS.maxMillis);
  boundedInt(t.unitRadius, "tunables.unitRadius", 0, INPUT_BOUNDS.maxDistance);
  boundedInt(t.keyframeIntervalMs, "tunables.keyframeIntervalMs", 1, INPUT_BOUNDS.maxMillis);
  if (t.pathConnectivity !== 4) fail("tunables.pathConnectivity must be 4 (4-connected lattice, no diagonals; fixed by design)");
  boundedInt(t.affinityAdvantageMult, "tunables.affinityAdvantageMult", 1, INPUT_BOUNDS.maxMult);
  boundedInt(t.affinityDisadvantageMult, "tunables.affinityDisadvantageMult", 1, INPUT_BOUNDS.maxMult);
  boundedInt(t.affinityNeutralMult, "tunables.affinityNeutralMult", 1, INPUT_BOUNDS.maxMult);
  const matrix = onlyKeys(t.affinityMatrix, "tunables.affinityMatrix", AFFINITY_CATEGORIES, fail);
  for (const dealer of AFFINITY_CATEGORIES) {
    const row = onlyKeys(matrix[dealer], `tunables.affinityMatrix.${dealer}`, AFFINITY_CATEGORIES, fail);
    for (const receiver of AFFINITY_CATEGORIES) oneOf(row[receiver], `tunables.affinityMatrix.${dealer}.${receiver}`, AFFINITY_OUTCOMES);
  }
  const table = eachOf(t.mergeStatMultByLevel, "tunables.mergeStatMultByLevel", fail);
  if (table.length < 2 || table.length > INPUT_BOUNDS.maxMergeLevels + 1) fail(`tunables.mergeStatMultByLevel must index merge levels 1..${INPUT_BOUNDS.maxMergeLevels} (index 0 unused)`);
  table.forEach((m, level) => {
    if (level === 0) positiveInt(m, "tunables.mergeStatMultByLevel[0]", 0);
    else boundedInt(m, `tunables.mergeStatMultByLevel[${level}]`, 1, INPUT_BOUNDS.maxMult);
  });
  boundedInt(t.trapTriggerRadius, "tunables.trapTriggerRadius", 0, INPUT_BOUNDS.maxDistance);
  boundedInt(t.siegeFenceDamageMult, "tunables.siegeFenceDamageMult", 1, INPUT_BOUNDS.maxMult);
  boundedInt(t.leashHysteresisMult, "tunables.leashHysteresisMult", 0, FIXED_POINT_SCALE);
}

/**
 * Full input validation: shape of all three parts, then the cross-checks the shape guards
 * cannot see — grid size matches the lattice, fences sit on ring cells at their own
 * segment, unique refs, posts and traps off the fences, hp bounds, every `pos` inside its
 * own `cell` (QA-10 N3), and every mover at least one fixed unit per tick
 * (moveSpeed ≥ tickRate, QA-10 S4 — a slower unit would floor to a speed of 0 and never
 * move, which no content value is meant to express).
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
  const tunables = i.tunables as ResolverTunables;
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
    if (f.maxHp > INPUT_BOUNDS.maxHp) fail(`fences[${idx}].maxHp must be ≤ ${INPUT_BOUNDS.maxHp}`);
    oneOf(f.category, `fences[${idx}].category`, FENCE_CATEGORIES);
    if (refs.includes(f.ref)) fail(`duplicate fence ref '${f.ref}'`);
    refs.push(f.ref);
    if (takenCells.some((c) => sameCell(c, f.cell))) fail(`two fences on segment ${f.segment}`);
    takenCells.push(f.cell);
  });
  const trapRefs: string[] = [];
  b.traps.forEach((t, idx) => {
    if (!isInBounds(t.cell) || isRingCell(t.cell) || isAnchorCell(t.cell)) fail(`traps[${idx}].cell is on the ring, an anchor, or off the lattice`);
    if (!sameCell(cellOf(t.pos), t.cell)) fail(`traps[${idx}].pos lies outside its cell`);
    if (t.damage > INPUT_BOUNDS.maxRating) fail(`traps[${idx}].damage must be ≤ ${INPUT_BOUNDS.maxRating}`);
    if (trapRefs.includes(t.ref)) fail(`duplicate trap ref '${t.ref}'`);
    trapRefs.push(t.ref);
    oneOf(t.category, `traps[${idx}].category`, TRAP_CATEGORIES);
    oneOf(t.affinity, `traps[${idx}].affinity`, AFFINITY_CATEGORIES);
  });
  const postRefs: string[] = [];
  b.posts.forEach((p, idx) => {
    if (!isInBounds(p.cell) || isRingCell(p.cell) || isAnchorCell(p.cell)) fail(`posts[${idx}].cell is on the ring, an anchor, or off the lattice`);
    if (p.hp < 1 || p.hp > p.maxHp) fail(`posts[${idx}] hp ${p.hp}/${p.maxHp} out of range (dead units are not posted)`);
    if (p.maxHp > INPUT_BOUNDS.maxHp) fail(`posts[${idx}].maxHp must be ≤ ${INPUT_BOUNDS.maxHp}`);
    if (p.defense < 1) fail(`posts[${idx}].defense must be ≥ 1`);
    if (p.defense > INPUT_BOUNDS.maxRating) fail(`posts[${idx}].defense must be ≤ ${INPUT_BOUNDS.maxRating}`);
    if (!sameCell(cellOf(p.pos), p.cell)) fail(`posts[${idx}].pos lies outside its cell`);
    if (p.moveSpeed < tunables.tickRate) fail(`posts[${idx}].moveSpeed ${p.moveSpeed} is below the tick rate ${tunables.tickRate}: it would never move`);
    if (p.moveSpeed > INPUT_BOUNDS.maxMoveSpeed) fail(`posts[${idx}].moveSpeed must be ≤ ${INPUT_BOUNDS.maxMoveSpeed}`);
    if (p.attackRange > INPUT_BOUNDS.maxDistance || p.aggroRadius > INPUT_BOUNDS.maxDistance || p.leashDistance > INPUT_BOUNDS.maxDistance) fail(`posts[${idx}] range/radius/leash must be ≤ ${INPUT_BOUNDS.maxDistance}`);
    if (p.attackCooldown > INPUT_BOUNDS.maxMillis) fail(`posts[${idx}].attackCooldown must be ≤ ${INPUT_BOUNDS.maxMillis}`);
    if (p.mergeLevel < 1 || p.mergeLevel >= tunables.mergeStatMultByLevel.length) fail(`posts[${idx}].mergeLevel ${p.mergeLevel} has no entry in tunables.mergeStatMultByLevel`);
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
    if (u.moveSpeed < tunables.tickRate) fail(`party.units[${idx}].moveSpeed ${u.moveSpeed} is below the tick rate ${tunables.tickRate}: it would never move`);
    if (u.mergeLevel >= tunables.mergeStatMultByLevel.length) fail(`party.units[${idx}].mergeLevel ${u.mergeLevel} has no entry in tunables.mergeStatMultByLevel`);
  });
  const siegeRefs: string[] = [];
  (i.party as Party).siege.forEach((s) => {
    if (siegeRefs.includes(s.ref)) fail(`duplicate siege ref '${s.ref}'`);
    siegeRefs.push(s.ref);
  });
  // Unused-but-documented: BATTLEFIELD_KEYS is the closed key set the battlefield guard uses.
  void BATTLEFIELD_KEYS;
}

/** A fresh matrix with its keys in AFFINITY_CATEGORIES order, so the copy carries no key-order trace of the input. */
function copyMatrix(m: AffinityMatrix): AffinityMatrix {
  return {
    grit: { grit: m.grit.grit, powder: m.grit.powder, beast: m.grit.beast },
    powder: { grit: m.powder.grit, powder: m.powder.powder, beast: m.powder.beast },
    beast: { grit: m.beast.grit, powder: m.beast.powder, beast: m.beast.beast },
  };
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
      pathConnectivity: input.battlefield.pathConnectivity,
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
      affinityAdvantageMult: input.tunables.affinityAdvantageMult,
      affinityDisadvantageMult: input.tunables.affinityDisadvantageMult,
      affinityNeutralMult: input.tunables.affinityNeutralMult,
      affinityMatrix: copyMatrix(input.tunables.affinityMatrix),
      mergeStatMultByLevel: [...input.tunables.mergeStatMultByLevel],
      trapTriggerRadius: input.tunables.trapTriggerRadius,
      siegeFenceDamageMult: input.tunables.siegeFenceDamageMult,
      leashHysteresisMult: input.tunables.leashHysteresisMult,
    },
  };
}
