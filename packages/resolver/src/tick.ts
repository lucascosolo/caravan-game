/**
 * One tick of the simulation (chunk 10).
 *
 * TICK_PHASE_ORDER — fixed here, in this order, forever (changing it changes every replay):
 *   1. retarget                 — an attacker re-evaluates its stance target ONLY when the
 *                                 current one is invalid (dead / spent / unreachable / none).
 *   2. path recompute (if due)  — every PATH_RECOMPUTE_INTERVAL ticks (tick % interval === 0,
 *                                 the same tick for every unit), plus immediately for a unit
 *                                 whose target changed, plus for every unit on the tick after
 *                                 a fence segment broke. Never at a data-dependent cadence.
 *   3. movement                 — continuous, fixed-point, sub-cell steps along the smoothed
 *                                 route; no unit–unit collision; fences and bounds only.
 *   4. trap triggers            — hook, chunk 11.
 *   5. posted-unit aggro/leash  — hook, chunk 11.
 *   6. attack cooldowns, damage — chunk 10: the fence BREACH hit only (a unit standing
 *                                 adjacent to the intact segment on its route hits it when
 *                                 its attack cooldown expires). Chunk 11 adds unit-vs-unit.
 *   7. abilities                — hook, chunk 12.
 *   8. death resolution         — chunk 10: fence destruction (hp ≤ 0 → broken; the grid is
 *                                 rebuilt and every path is recomputed next tick). Chunk 11
 *                                 adds unit death.
 *   then a keyframe every keyframeInterval ticks and on the last tick.
 *
 * Within every phase, units are visited in ASCENDING UNIT ID and nothing else; every "the
 * nearest X" picks the LOWEST ID (or lowest trap index) on an exact tie. Those two rules
 * are the only tie-breaks the tick loop has, and tests pin both.
 *
 * RETARGET_RULE fallback chain (documented so chunk 11 keeps it):
 *   nearest : nearest living posted unit → the core
 *   traps   : nearest unspent trap → nearest living posted unit → the core
 *   core    : the core
 * A candidate that proved unreachable (no route even by breaching — only an anchor or a
 * sealed pocket can cause it) is skipped for the rest of the fight.
 *
 * MOVEMENT_HOLD: an attacker whose target is a unit within its attack range does not move
 * (it is engaged; chunk 11 makes it attack). One whose route is blocked by an intact
 * segment stands in the adjacent cell and breaches. One with no route left has arrived.
 */
import { CORE_CENTER_CELL, FIELD_HEIGHT, FIELD_WIDTH, cellCenter, cellDistSq, cellKey, cellOf, isCoreCell, type Cell, type Fixed, type FixedPoint } from "./battlefield.js";
import { ceilDiv, clamp, isqrt } from "./fixed.js";
import { abilityPhase, fenceHitDamage, postedUnitPhase, trapTriggerPhase } from "./hooks.js";
import { logTarget, type LogEvent } from "./log.js";
import { CELL_FREE, findPath, smoothPath, type Waypoint } from "./path.js";
import { isFree, sameTarget, type SimState, type Target, type UnitState } from "./state.js";

function distSqUnits(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function targetValid(state: SimState, t: Target): boolean {
  if (t.kind === "core") return true;
  if (t.kind === "unit") return state.units[t.id]!.alive;
  return !state.traps[t.index]!.spent;
}

function isUnreachable(u: UnitState, t: Target): boolean {
  return u.unreachable.some((x) => sameTarget(x, t));
}

/** Nearest living posted unit by squared distance; exact tie → lowest id. */
function nearestDefender(state: SimState, u: UnitState): Target | null {
  let best: UnitState | null = null;
  let bestD = 0;
  for (let id = state.attackerCount; id < state.units.length; id++) {
    const d = state.units[id]!;
    if (!d.alive) continue;
    const t: Target = { kind: "unit", id };
    if (isUnreachable(u, t)) continue;
    const dd = distSqUnits(u, d);
    if (best === null || dd < bestD) {
      best = d;
      bestD = dd;
    }
  }
  return best === null ? null : { kind: "unit", id: best.id };
}

/** Nearest unspent trap by squared distance; exact tie → lowest trap index. */
function nearestTrap(state: SimState, u: UnitState): Target | null {
  let best = -1;
  let bestD = 0;
  for (const t of state.traps) {
    if (t.spent) continue;
    const target: Target = { kind: "trap", index: t.index };
    if (isUnreachable(u, target)) continue;
    const dd = distSqUnits(u, t.pos);
    if (best < 0 || dd < bestD) {
      best = t.index;
      bestD = dd;
    }
  }
  return best < 0 ? null : { kind: "trap", index: best };
}

function chooseTarget(state: SimState, u: UnitState): Target | null {
  const core: Target = { kind: "core" };
  const coreOrNull = isUnreachable(u, core) ? null : core;
  switch (u.stance) {
    case "nearest":
      return nearestDefender(state, u) ?? coreOrNull;
    case "traps":
      return nearestTrap(state, u) ?? nearestDefender(state, u) ?? coreOrNull;
    case "core":
      return coreOrNull;
    default:
      return null;
  }
}

function targetCell(state: SimState, t: Target): Cell {
  if (t.kind === "core") return CORE_CENTER_CELL;
  if (t.kind === "unit") {
    const d = state.units[t.id]!;
    return cellOf({ x: d.x, y: d.y });
  }
  return state.traps[t.index]!.cell;
}

/** Whether an attacker's unit target is inside its attack range (inclusive). */
function engaged(state: SimState, u: UnitState): boolean {
  if (u.target === null || u.target.kind !== "unit") return false;
  const d = state.units[u.target.id]!;
  return d.alive && distSqUnits(u, d) <= u.attackRangeSq;
}

// ─── Phase 1 ────────────────────────────────────────────────────────────────────────

export function retargetPhase(state: SimState, log: LogEvent[]): void {
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive) continue;
    if (u.target !== null && targetValid(state, u.target)) continue;
    const next = chooseTarget(state, u);
    if (sameTarget(next, u.target)) continue;
    u.target = next;
    u.pathDirty = true;
    u.waypoints = [];
    u.breaching = -1;
    log.push({ t: state.tick, k: "target", u: id, target: logTarget(next) });
  }
}

// ─── Phase 2 ────────────────────────────────────────────────────────────────────────

function sameRoute(a: readonly Waypoint[], b: readonly Waypoint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.x !== q.x || p.y !== q.y || p.breach !== q.breach) return false;
  }
  return true;
}

/**
 * FENCE_BLOCKS_PATHING cost: the distance (fixed cells) the unit could have walked in the
 * ticks it needs to destroy the segment = hits × cooldownTicks × speedPerTick, where
 * hits = ⌈hp / damage per hit⌉. A unit that cannot move has no use for the estimate.
 */
export function breachCostFor(state: SimState, u: UnitState): (fenceIndex: number) => number {
  return (fenceIndex: number): number => {
    const fence = state.fences[fenceIndex]!;
    const hits = ceilDiv(fence.hp, fenceHitDamage(state, u, fence));
    return hits * u.cooldownTicks * u.speedPerTick;
  };
}

export function pathPhase(state: SimState, log: LogEvent[]): void {
  const intervalDue = state.tick % state.pathRecomputeInterval === 0;
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive) continue;
    const due = intervalDue || u.pathDirty || state.fenceBrokeSinceRecompute;
    if (!due) continue;
    u.pathDirty = false;
    if (u.target === null) {
      if (u.waypoints.length > 0) {
        u.waypoints = [];
        log.push({ t: state.tick, k: "path", u: id, speed: u.speedPerTick, wp: [] });
      }
      continue;
    }
    if (engaged(state, u)) {
      // In range of its unit target: no route needed. Dropped silently; `hold` logs the stop.
      u.waypoints = [];
      u.breaching = -1;
      continue;
    }
    const from: FixedPoint = { x: u.x, y: u.y };
    const steps = findPath(state.grid, cellOf(from), targetCell(state, u.target), breachCostFor(state, u));
    // (goal recomputed below only to place the final waypoint at the cell centre)
    if (steps === null) {
      u.unreachable.push(u.target);
      u.target = null;
      u.waypoints = [];
      u.breaching = -1;
      log.push({ t: state.tick, k: "target", u: id, target: null });
      continue;
    }
    const goal = targetCell(state, u.target);
    const route = smoothPath(state.grid, from, steps);
    // Already inside the goal cell: finish at its centre (the route would otherwise be empty
    // and the unit would stop wherever it entered the cell).
    if (steps.length === 0) {
      const c = cellCenter(goal);
      if (c.x !== u.x || c.y !== u.y) route.push({ x: c.x, y: c.y, breach: -1 });
    }
    if (!sameRoute(route, u.waypoints)) {
      u.waypoints = route;
      log.push({ t: state.tick, k: "path", u: id, speed: u.speedPerTick, wp: route.map((w) => [w.x, w.y, w.breach] as const) });
    }
  }
  state.fenceBrokeSinceRecompute = false;
}

// ─── Phase 3 ────────────────────────────────────────────────────────────────────────

export function movementPhase(state: SimState, log: LogEvent[]): void {
  const maxX = FIELD_WIDTH - 1;
  const maxY = FIELD_HEIGHT - 1;
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive) continue;
    let moved = false;
    u.breaching = -1;
    if (!engaged(state, u)) {
      let remaining = u.speedPerTick;
      while (remaining > 0 && u.waypoints.length > 0) {
        const wp = u.waypoints[0]!;
        if (wp.breach >= 0 && state.fences[wp.breach]!.intact) {
          // The next cell is an intact segment: stand here and breach it (phase 6).
          u.breaching = wp.breach;
          break;
        }
        const dx = wp.x - u.x;
        const dy = wp.y - u.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= remaining * remaining) {
          u.x = wp.x;
          u.y = wp.y;
          remaining -= isqrt(d2);
          u.waypoints.shift();
          moved = true;
          continue;
        }
        // Scale the integer direction vector: step = d × remaining / |d|, floored.
        const len = isqrt(d2);
        const nx = clamp(u.x + Math.floor((dx * remaining) / len), 0, maxX) as Fixed;
        const ny = clamp(u.y + Math.floor((dy * remaining) / len), 0, maxY) as Fixed;
        if (!isFree(state.grid, cellOf({ x: nx, y: ny }))) {
          // Cannot happen on a route with line of sight; if it ever does, stop and re-plan.
          u.pathDirty = true;
          break;
        }
        u.x = nx;
        u.y = ny;
        moved = true;
        remaining = 0;
      }
    }
    const holding = !moved;
    if (holding !== u.holding) {
      u.holding = holding;
      log.push({ t: state.tick, k: "hold", u: id, holding });
    }
    if (u.reachedCoreTick < 0 && isCoreCell(cellOf({ x: u.x, y: u.y }))) {
      u.reachedCoreTick = state.tick;
      log.push({ t: state.tick, k: "core_reached", u: id });
    }
  }
}

// ─── Phase 6 ────────────────────────────────────────────────────────────────────────

export function attackPhase(state: SimState, log: LogEvent[]): void {
  for (const u of state.units) {
    if (!u.alive) continue;
    if (u.cooldownRemaining > 0) u.cooldownRemaining--;
    if (u.side !== "attacker" || u.breaching < 0) continue;
    const fence = state.fences[u.breaching]!;
    if (!fence.intact || fence.hp <= 0) continue; // already destroyed this tick (phase 8 clears it)
    // FENCE_BREACH_RANGE: the unit's cell is orthogonally adjacent to the segment's cell.
    if (cellDistSq(cellOf({ x: u.x, y: u.y }), fence.cell) !== 1) continue;
    if (u.cooldownRemaining > 0) continue;
    const damage = fenceHitDamage(state, u, fence);
    fence.hp = fence.hp - damage < 0 ? 0 : fence.hp - damage;
    u.cooldownRemaining = u.cooldownTicks;
    log.push({ t: state.tick, k: "fence_hit", u: u.id, f: fence.index, damage, hp: fence.hp });
  }
  // TODO(chunk-11): unit-vs-unit hits (offense²/(offense+defense), affinity, simultaneity).
}

// ─── Phase 8 ────────────────────────────────────────────────────────────────────────

export function deathPhase(state: SimState, log: LogEvent[]): void {
  for (const fence of state.fences) {
    if (!fence.intact || fence.hp > 0) continue;
    fence.intact = false;
    fence.brokenTick = state.tick;
    state.grid[cellKey(fence.cell)] = CELL_FREE;
    state.fenceBrokeSinceRecompute = true;
    log.push({ t: state.tick, k: "fence_broken", f: fence.index });
    for (const u of state.units) {
      if (u.breaching === fence.index) {
        u.breaching = -1;
        u.pathDirty = true;
      }
    }
  }
  // TODO(chunk-11): unit deaths (hp ≤ 0 → alive = false), mutual kills, de-targeting.
}

// ─── The tick ───────────────────────────────────────────────────────────────────────

export function keyframe(state: SimState, log: LogEvent[]): void {
  log.push({
    t: state.tick,
    k: "keyframe",
    units: state.units.map((u) => ({ u: u.id, x: u.x, y: u.y, hp: u.hp, alive: u.alive })),
    fences: state.fences.map((f) => ({ f: f.index, hp: f.hp })),
    traps: state.traps.map((t) => ({ i: t.index, spent: t.spent })),
  });
}

/** Run every phase for `state.tick`, in TICK_PHASE_ORDER, then the keyframe if due. */
export function runTick(state: SimState, log: LogEvent[]): void {
  retargetPhase(state, log); // 1
  pathPhase(state, log); // 2
  movementPhase(state, log); // 3
  trapTriggerPhase(state, log); // 4 (chunk 11)
  postedUnitPhase(state, log); // 5 (chunk 11)
  attackPhase(state, log); // 6
  abilityPhase(state, log); // 7 (chunk 12)
  deathPhase(state, log); // 8
  const done = state.tick + 1;
  if (done % state.keyframeInterval === 0 || done === state.tickCap) keyframe(state, log);
}
