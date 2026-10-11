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
import { fixedSq, type Millis } from "./fixed.js";
import type { ResolveInput, SiegeCounter, Stance } from "./input.js";

export type Side = "attacker" | "defender";

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
  readonly maxHp: number;
  readonly speedPerTick: number;
  readonly attackRange: Fixed;
  readonly attackRangeSq: number;
  readonly cooldownTicks: number;
  readonly aggroRadius: Fixed;
  readonly leashDistance: Fixed;
  readonly ability: Ability;
  // ---- mutable ----
  x: Fixed;
  y: Fixed;
  hp: number;
  alive: boolean;
  /** Ticks until the next attack may fire; 0 = ready. Starts at 0. */
  cooldownRemaining: number;
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
  spent: boolean;
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
  const common = (ability: Ability, attackRange: Fixed, attackCooldown: Millis) => ({
    attackRange,
    attackRangeSq: fixedSq(attackRange),
    cooldownTicks: msToTicks(attackCooldown, tunables.tickRate),
    ability,
    cooldownRemaining: 0,
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
      maxHp: u.maxHp,
      speedPerTick: speedPerTick(u.moveSpeed, tunables.tickRate),
      aggroRadius: 0 as Fixed,
      leashDistance: 0 as Fixed,
      x: pos.x,
      y: pos.y,
      hp: u.hp,
      ...common(u.ability, u.attackRange, u.attackCooldown),
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
      maxHp: p.maxHp,
      speedPerTick: speedPerTick(p.moveSpeed, tunables.tickRate),
      aggroRadius: p.aggroRadius,
      leashDistance: p.leashDistance,
      x: p.pos.x,
      y: p.pos.y,
      hp: p.hp,
      ...common(p.ability, p.attackRange, p.attackCooldown),
    });
  }
  const fences: FenceState[] = battlefield.fences.map((f, index) => ({
    index,
    ref: f.ref,
    segment: f.segment,
    cell: f.cell,
    category: f.category,
    maxHp: f.maxHp,
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
    spent: false,
  }));
  return {
    tickRate: tunables.tickRate,
    tickCap: tunables.battleLengthCapSeconds * tunables.tickRate,
    pathRecomputeInterval: msToTicks(tunables.pathRecomputeIntervalMs, tunables.tickRate),
    keyframeInterval: msToTicks(tunables.keyframeIntervalMs, tunables.tickRate),
    unitRadius: tunables.unitRadius,
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
