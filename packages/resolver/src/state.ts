/**
 * Simulation state (chunk 10). Everything the tick loop reads or writes lives here, in
 * plain arrays ordered by id, with every numeric field a safe integer (a test asserts
 * this on every field after every tick).
 *
 * UNIT IDS — the total ordering every tie-break in the resolver falls back to (chunk 10
 * "ascending unit id"): attackers first in ref order (ids 0..A−1), then posted units in
 * ref order (ids A..A+D−1). The input is normalized to ref order on entry (input.ts), so
 * ids are a pure function of the input's contents, not of its array order.
 *
 * PER-TICK QUANTITIES are derived ONCE at setup from the content values and the tick rate:
 *   speedPerTick   = floor(moveSpeed_fixed / tickRate)            (fixed cells per tick)
 *   cooldownTicks  = max(1, floor(attackCooldown_ms × tickRate / 1000))
 * Both floor (fixed.ts rounding mode). 1.5 cells/s at 20 ticks/s → 76 (brief: 76.8).
 * Input validation requires moveSpeed ≥ tickRate, so speedPerTick is never 0 (QA-10 S4).
 *
 * A LEG is the straight run from where a unit stood when its current waypoint became the
 * head of its route (`legX`/`legY`) to that waypoint; `legLen` is its integer length and
 * `legProgress` the distance covered so far. Movement places the unit at
 * `leg anchor + sign(d) × floor(|d| × progress / len)` per axis (tick.ts), never by re-aiming from a
 * rounded position, so rounding never accumulates (QA-10 S2). `legLen` −1 = no leg started.
 */
import { CELL_ANCHOR, CELL_FREE, emptyGrid, type PathGrid, type Waypoint } from "./path.js";
import { type Ability, type AffinityCategory, type Cell, type Fixed, type FixedPoint, type PostStance, type TrapCategory, type TrapEffect, type FenceCategory, cellCenter, cellKey } from "./battlefield.js";
import { FIXED_ONE, fixedSq, fpMul, type Millis } from "./fixed.js";
import type { AffinityMatrix, ResolveInput, SiegeCounter, Stance } from "./input.js";

export type Side = "attacker" | "defender";

/**
 * A posted unit's movement mode (chunk 11, phase 5). `idle`: at its post, watching its aggro
 * radius. `pursuing`: chasing `target` within its leash. `returning`: walking back to its
 * post after a disengage, deaf to aggro until inside the hysteresis radius. Attackers are
 * always `idle` (the field is unused for them); `hold` posts never leave `idle`.
 */
export type PostMode = "idle" | "pursuing" | "returning";

/** What an attacker is currently moving toward. Posted units have no target in chunk 10. */
export type Target = { readonly kind: "core" } | { readonly kind: "unit"; readonly id: number } | { readonly kind: "trap"; readonly index: number };

export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "unit" && b.kind === "unit") return a.id === b.id;
  if (a.kind === "trap" && b.kind === "trap") return a.index === b.index;
  return true;
}

export interface UnitState {
  readonly id: number;
  readonly side: Side;
  readonly ref: string;
  readonly typeId: string;
  readonly mergeLevel: number;
  /** Attackers: targeting stance. Defenders: null (their stance is `postStance`). */
  readonly stance: Stance | null;
  readonly postStance: PostStance | null;
  /** Defenders: the post cell. Attackers: the entry cell. */
  readonly homeCell: Cell;
  readonly affinity: AffinityCategory;
  /** Attackers carry offense, defenders carry defense; the other slot is 0 and never read. */
  readonly offense: number;
  readonly defense: number;
  /**
   * DAMAGE_SLOTS (chunk 11): the ONE rating this unit brings to this fight — `offense` for
   * an attacker, `defense` for a posted unit. It fills the formula's first slot when the
   * unit deals a hit and the second slot when it receives one (combat.ts `hitDamage`).
   * Unmerged: the merge multiplier never touches a rating (chunk 03 QA B1).
   */
  readonly rating: number;
  /** MERGE_STAT_MULT_BY_LEVEL[mergeLevel]: applied to every hit this unit deals, after the formula. */
  readonly mergeMult: Fixed;
  readonly maxHp: number;
  readonly speedPerTick: number;
  readonly attackRange: Fixed;
  readonly attackRangeSq: number;
  /** REACH rule: (attackRange + unitRadius)², the squared distance within which this unit hits. */
  readonly reachSq: number;
  readonly cooldownTicks: number;
  readonly aggroRadius: Fixed;
  readonly leashDistance: Fixed;
  /** Defenders: (aggroRadius + unitRadius)², leashDistance², (leashDistance × hysteresis)². 0 for attackers. */
  readonly aggroSq: number;
  readonly leashSq: number;
  readonly hysteresisSq: number;
  /** Defenders: the post's tick-zero position, the origin of the leash. Attackers: the entry position. */
  readonly postX: Fixed;
  readonly postY: Fixed;
  readonly ability: Ability;
  // ---- mutable ----
  x: Fixed;
  y: Fixed;
  hp: number;
  alive: boolean;
  /** Tick the unit died on (phase 8), or −1. */
  diedTick: number;
  /** Ticks until the next attack may fire; 0 = ready. Starts at 0. */
  cooldownRemaining: number;
  /** Trap effects (phase 4): remaining ticks of slow / root and the slow's magnitude (Fixed fraction of speed lost). */
  slowRemaining: number;
  slowMagnitude: Fixed;
  rootRemaining: number;
  /** The speed per tick movement used on the last tick (base, slowed, or 0 while rooted); logged on change. */
  speedInForce: number;
  /** The polyline this unit swept THIS tick: its start-of-tick position, every waypoint it landed on, its end position. */
  sweep: FixedPoint[];
  /** Defenders: movement mode (phase 5). */
  postMode: PostMode;
  /** Defenders with the `reserve` stance: whether an attacker has entered the ring yet. */
  reserveReleased: boolean;
  target: Target | null;
  /** Targets that proved unreachable; skipped by retargeting. */
  unreachable: Target[];
  /** Remaining waypoints; waypoints[0] is the one being moved toward. */
  waypoints: Waypoint[];
  /** The current leg's anchor (see header); meaningful while legLen ≥ 0. */
  legX: Fixed;
  legY: Fixed;
  /** Integer length of the current leg from its anchor to waypoints[0], or −1 (not started). */
  legLen: number;
  /** Distance covered along the current leg, 0..legLen. */
  legProgress: number;
  /** Whether phase 2 must recompute this unit's path this tick regardless of the interval. */
  pathDirty: boolean;
  /** Fence index this unit is standing adjacent to and breaking through, or −1. */
  breaching: number;
  /** Whether the unit is holding position (target in range / arrived); logged on change. */
  holding: boolean;
  /** Tick on which this unit first stood on a core cell, or −1. */
  reachedCoreTick: number;
}

export interface FenceState {
  readonly index: number;
  readonly ref: string;
  readonly segment: number;
  readonly cell: Cell;
  readonly category: FenceCategory;
  readonly maxHp: number;
  /** Whether the party carries a siege piece countering this segment's category (SIEGE_FENCE_DAMAGE_MULT applies). */
  readonly siegeCountered: boolean;
  hp: number;
  intact: boolean;
  /** Tick it broke on, or −1. */
  brokenTick: number;
}

export interface TrapState {
  readonly index: number;
  readonly ref: string;
  readonly cell: Cell;
  readonly pos: FixedPoint;
  readonly typeId: string;
  readonly category: TrapCategory;
  readonly affinity: AffinityCategory;
  readonly damage: number;
  readonly effect: TrapEffect | null;
  /** Whether the party carries a siege piece countering this trap's category (SIEGE_TRAP_NULLIFY: fires blank, still spent). */
  readonly siegeCountered: boolean;
  spent: boolean;
  /** Tick it fired (or was nullified) on, or −1. */
  spentTick: number;
}

export interface SiegeState {
  readonly ref: string;
  readonly typeId: string;
  readonly counters: SiegeCounter;
}

export interface SimState {
  readonly tickRate: number;
  readonly tickCap: number;
  readonly pathRecomputeInterval: number;
  readonly keyframeInterval: number;
  readonly unitRadius: Fixed;
  // ---- chunk 11 combat tunables, as handed in ----
  readonly affinityAdvantageMult: Fixed;
  readonly affinityDisadvantageMult: Fixed;
  readonly affinityNeutralMult: Fixed;
  readonly affinityMatrix: AffinityMatrix;
  /** (trapTriggerRadius + unitRadius)²: a trap fires when a swept path comes this close to its centre. */
  readonly trapReachSq: number;
  readonly siegeFenceDamageMult: Fixed;
  tick: number;
  /** All units, index === id. */
  readonly units: UnitState[];
  readonly attackerCount: number;
  readonly fences: FenceState[];
  readonly traps: TrapState[];
  readonly siege: readonly SiegeState[];
  /** Pathing grid: rebuilt whenever a fence breaks. */
  grid: PathGrid;
  /** Set in phase 8 when a fence broke this tick; phase 2 of the NEXT tick recomputes every path. */
  fenceBrokeSinceRecompute: boolean;
}

export function msToTicks(ms: Millis, tickRate: number): number {
  const t = Math.floor((ms * tickRate) / 1000);
  return t < 1 ? 1 : t;
}

export function speedPerTick(moveSpeed: Fixed, tickRate: number): number {
  return Math.floor(moveSpeed / tickRate);
}

export function buildGrid(fences: readonly FenceState[], anchors: readonly Cell[]): PathGrid {
  const grid = emptyGrid();
  for (const a of anchors) grid[cellKey(a)] = CELL_ANCHOR;
  for (const f of fences) if (f.intact) grid[cellKey(f.cell)] = f.index;
  return grid;
}

/** Build tick-zero state from a validated, normalized input. */
export function initialState(input: ResolveInput): SimState {
  const { battlefield, party, tunables } = input;
  const units: UnitState[] = [];
  const siegeCounters = (kind: "fence" | "trap", category: string): boolean => party.siege.some((s) => s.counters.kind === kind && s.counters.category === category);
  const common = (ability: Ability, attackRange: Fixed, attackCooldown: Millis, mergeLevel: number, pos: FixedPoint) => ({
    attackRange,
    attackRangeSq: fixedSq(attackRange),
    reachSq: fixedSq((attackRange + tunables.unitRadius) as Fixed),
    cooldownTicks: msToTicks(attackCooldown, tunables.tickRate),
    mergeMult: tunables.mergeStatMultByLevel[mergeLevel] ?? FIXED_ONE,
    postX: pos.x,
    postY: pos.y,
    ability,
    diedTick: -1,
    cooldownRemaining: 0,
    slowRemaining: 0,
    slowMagnitude: 0 as Fixed,
    rootRemaining: 0,
    sweep: [] as FixedPoint[],
    postMode: "idle" as PostMode,
    reserveReleased: false,
    target: null,
    unreachable: [] as Target[],
    waypoints: [] as Waypoint[],
    legX: 0 as Fixed,
    legY: 0 as Fixed,
    legLen: -1,
    legProgress: 0,
    pathDirty: true,
    breaching: -1,
    holding: false,
    reachedCoreTick: -1,
    alive: true,
  });
  for (const u of party.units) {
    const pos = cellCenter(u.entry.cell);
    units.push({
      id: units.length,
      side: "attacker",
      ref: u.ref,
      typeId: u.typeId,
      mergeLevel: u.mergeLevel,
      stance: u.stance,
      postStance: null,
      homeCell: u.entry.cell,
      affinity: u.affinity,
      offense: u.offense,
      defense: 0,
      rating: u.offense,
      maxHp: u.maxHp,
      speedPerTick: speedPerTick(u.moveSpeed, tunables.tickRate),
      speedInForce: speedPerTick(u.moveSpeed, tunables.tickRate),
      aggroRadius: 0 as Fixed,
      leashDistance: 0 as Fixed,
      aggroSq: 0,
      leashSq: 0,
      hysteresisSq: 0,
      x: pos.x,
      y: pos.y,
      hp: u.hp,
      ...common(u.ability, u.attackRange, u.attackCooldown, u.mergeLevel, pos),
    });
  }
  const attackerCount = units.length;
  for (const p of battlefield.posts) {
    units.push({
      id: units.length,
      side: "defender",
      ref: p.ref,
      typeId: p.typeId,
      mergeLevel: p.mergeLevel,
      stance: null,
      postStance: p.stance,
      homeCell: p.cell,
      affinity: p.affinity,
      offense: 0,
      defense: p.defense,
      rating: p.defense,
      maxHp: p.maxHp,
      speedPerTick: speedPerTick(p.moveSpeed, tunables.tickRate),
      speedInForce: speedPerTick(p.moveSpeed, tunables.tickRate),
      aggroRadius: p.aggroRadius,
      leashDistance: p.leashDistance,
      aggroSq: fixedSq((p.aggroRadius + tunables.unitRadius) as Fixed),
      leashSq: fixedSq(p.leashDistance),
      hysteresisSq: fixedSq(fpMul(p.leashDistance, tunables.leashHysteresisMult)),
      x: p.pos.x,
      y: p.pos.y,
      hp: p.hp,
      ...common(p.ability, p.attackRange, p.attackCooldown, p.mergeLevel, p.pos),
      // A posted unit starts standing on its post; `hold` is logged only when it first moves.
      holding: true,
    });
  }
  const fences: FenceState[] = battlefield.fences.map((f, index) => ({
    index,
    ref: f.ref,
    segment: f.segment,
    cell: f.cell,
    category: f.category,
    maxHp: f.maxHp,
    siegeCountered: siegeCounters("fence", f.category),
    hp: f.hp,
    intact: f.hp > 0,
    brokenTick: f.hp > 0 ? -1 : 0,
  }));
  const traps: TrapState[] = battlefield.traps.map((t, index) => ({
    index,
    ref: t.ref,
    cell: t.cell,
    pos: t.pos,
    typeId: t.typeId,
    category: t.category,
    affinity: t.affinity,
    damage: t.damage,
    effect: t.effect,
    siegeCountered: siegeCounters("trap", t.category),
    spent: false,
    spentTick: -1,
  }));
  return {
    tickRate: tunables.tickRate,
    tickCap: tunables.battleLengthCapSeconds * tunables.tickRate,
    pathRecomputeInterval: msToTicks(tunables.pathRecomputeIntervalMs, tunables.tickRate),
    keyframeInterval: msToTicks(tunables.keyframeIntervalMs, tunables.tickRate),
    unitRadius: tunables.unitRadius,
    affinityAdvantageMult: tunables.affinityAdvantageMult,
    affinityDisadvantageMult: tunables.affinityDisadvantageMult,
    affinityNeutralMult: tunables.affinityNeutralMult,
    affinityMatrix: tunables.affinityMatrix,
    trapReachSq: fixedSq((tunables.trapTriggerRadius + tunables.unitRadius) as Fixed),
    siegeFenceDamageMult: tunables.siegeFenceDamageMult,
    tick: 0,
    units,
    attackerCount,
    fences,
    traps,
    siege: party.siege.map((s) => ({ ref: s.ref, typeId: s.typeId, counters: s.counters })),
    grid: buildGrid(fences, battlefield.anchors),
    fenceBrokeSinceRecompute: false,
  };
}

export function isFree(grid: PathGrid, cell: Cell): boolean {
  return (grid[cellKey(cell)] ?? CELL_ANCHOR) === CELL_FREE;
}
