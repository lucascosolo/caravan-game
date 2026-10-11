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
 *
 * MOVEMENT_LEG (QA-10 S2): a unit advances along its current waypoint leg PARAMETRICALLY —
 * position = leg anchor + sign(d) × floor(|d| × progress / len) per axis (`legOffset`),
 * where the anchor is where it stood when the leg began and len = isqrt(|d|²) is fixed for
 * the leg — never by re-aiming from its last rounded position. Rounding is therefore < 1 unit off the exact line for
 * the whole leg, and the leg itself was accepted by smoothing with LOS_LEG_MARGIN, so no
 * step can clip an intact cell's corner. When the leg's remaining length fits the tick's
 * budget the unit lands exactly on the waypoint and spends the surplus on the next leg
 * (QA-10 N1: arrival is `len − progress ≤ remaining`, so a step that would land exactly on
 * the waypoint consumes it in the same tick).
 *
 * FENCE_BLOCKS_PATHING price (QA-10 S1): a breach edge costs the distance the unit could
 * have walked in the ticks it will stand still — hits land on arrival and then every
 * cooldownTicks, the segment breaks on the last hit and the unit moves again on the NEXT
 * tick (phase 2 recompute precedes phase 3 movement, so that tick is not lost):
 *   stationary ticks = (hits − 1) × cooldownTicks + max(0, cooldownRemaining − 1)
 * (a cooldown of 1 fires on the arrival tick because phase 6 decrements before it checks).
 * The cooldownRemaining term is the unit's value when the path is planned — an
 * over-estimate of at most the ticks it walks before arriving; exact when it plans on
 * arrival, which is what the determinism probe measures.
 *
 * ROUTE_CHOICE (QA-10 S1, second half): the lattice prices a detour in Manhattan steps,
 * but the unit walks the string-pulled route, which can be far shorter (a two-cell
 * sidestep through a gap is 4 lattice steps ≈ 54 ticks on the lattice and ≈ 5 ticks on
 * foot). So when the best lattice route breaches, the best breach-free lattice route is
 * found too, both are smoothed, and the one with the lower MEASURED cost — smoothed
 * length plus the breach price above — is taken; an exact tie walks around (the gap is
 * what the defender built). Which segment to breach, when breaching wins, is still the
 * lattice's single-edge comparison. Two A* runs at most, only on a recompute whose
 * lattice route breaches.
 */
import { CORE_CENTER_CELL, FIELD_HEIGHT, FIELD_WIDTH, cellCenter, cellDistSq, cellKey, cellOf, isCoreCell, type Cell, type Fixed, type FixedPoint } from "./battlefield.js";
import { COST_INFINITE, ceilDiv, clamp, isqrt } from "./fixed.js";
import { abilityPhase, fenceHitDamage, postedUnitPhase, trapTriggerPhase } from "./hooks.js";
import { logTarget, type LogEvent } from "./log.js";
import { BREACH_COST_MAX, CELL_FREE, findPath, losClear, smoothPath, type Waypoint } from "./path.js";
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
    u.legLen = -1;
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
 * FENCE_BLOCKS_PATHING cost (see header): the distance (fixed cells) the unit could have
 * walked in the ticks it will stand still to destroy the segment,
 *   ((hits − 1) × cooldownTicks + max(0, cooldownRemaining − 1)) × speedPerTick,
 * hits = ⌈hp / damage per hit⌉. Clamped to BREACH_COST_MAX: a breakable segment is never
 * priced as a wall, however sturdy (QA-10 S3). The factors are bounded by input validation
 * (INPUT_BOUNDS), so the product is a safe integer before the clamp.
 */
export function breachCostFor(state: SimState, u: UnitState): (fenceIndex: number) => number {
  return (fenceIndex: number): number => {
    const fence = state.fences[fenceIndex]!;
    const hits = ceilDiv(fence.hp, fenceHitDamage(state, u, fence));
    const waitTicks = (hits > 1 ? hits - 1 : 0) * u.cooldownTicks + (u.cooldownRemaining > 1 ? u.cooldownRemaining - 1 : 0);
    const cost = waitTicks * u.speedPerTick;
    return cost > BREACH_COST_MAX ? BREACH_COST_MAX : cost;
  };
}

/**
 * ROUTE_CHOICE measure of a smoothed route from `from`: the walked length (sum of integer
 * leg lengths, the same isqrt movement uses) plus the breach price of every segment on it.
 */
export function routeCost(from: FixedPoint, route: readonly Waypoint[], breachCost: (fenceIndex: number) => number): number {
  let total = 0;
  let prev: FixedPoint = from;
  for (const wp of route) {
    const dx = wp.x - prev.x;
    const dy = wp.y - prev.y;
    total += isqrt(dx * dx + dy * dy);
    if (wp.breach >= 0) total += breachCost(wp.breach);
    prev = wp;
  }
  return total;
}

const noBreach = (): number => COST_INFINITE;

/**
 * Plan a unit's route (see ROUTE_CHOICE): null when the goal is unreachable even by
 * breaching. Exported for tests.
 */
export function planRoute(state: SimState, u: UnitState, from: FixedPoint, goal: Cell): Waypoint[] | null {
  const breachCost = breachCostFor(state, u);
  const steps = findPath(state.grid, cellOf(from), goal, breachCost);
  if (steps === null) return null;
  let route = smoothPath(state.grid, from, steps);
  if (steps.some((s) => s.breach >= 0)) {
    const around = findPath(state.grid, cellOf(from), goal, noBreach);
    if (around !== null) {
      const routeAround = smoothPath(state.grid, from, around);
      if (routeCost(from, routeAround, breachCost) <= routeCost(from, route, breachCost)) route = routeAround;
    }
  }
  // Already inside the goal cell: finish at its centre (the route would otherwise be empty
  // and the unit would stop wherever it entered the cell).
  if (steps.length === 0) {
    const c = cellCenter(goal);
    if (c.x !== from.x || c.y !== from.y) route.push({ x: c.x, y: c.y, breach: -1 });
  }
  return route;
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
        u.legLen = -1;
        log.push({ t: state.tick, k: "path", u: id, speed: u.speedPerTick, wp: [] });
      }
      continue;
    }
    if (engaged(state, u)) {
      // In range of its unit target: no route needed. Dropped silently; `hold` logs the stop.
      u.waypoints = [];
      u.legLen = -1;
      u.breaching = -1;
      continue;
    }
    const from: FixedPoint = { x: u.x, y: u.y };
    const route = planRoute(state, u, from, targetCell(state, u.target));
    if (route === null) {
      u.unreachable.push(u.target);
      u.target = null;
      u.waypoints = [];
      u.legLen = -1;
      u.breaching = -1;
      log.push({ t: state.tick, k: "target", u: id, target: null });
      continue;
    }
    if (!sameRoute(route, u.waypoints)) {
      // A new route starts a new leg from where the unit stands now; an unchanged route
      // keeps the leg in progress (and logs nothing — see log.ts INTERPOLATION CONTRACT).
      u.waypoints = route;
      u.legLen = -1;
      log.push({ t: state.tick, k: "path", u: id, speed: u.speedPerTick, wp: route.map((w) => [w.x, w.y, w.breach] as const) });
    }
  }
  state.fenceBrokeSinceRecompute = false;
}

// ─── Phase 3 ────────────────────────────────────────────────────────────────────────

/**
 * One axis of a leg offset: sign(d) × floor(|d| × progress / len). Floor division on
 * non-negative operands (fixed.ts rounding mode), applied to the magnitude so the result
 * rounds toward the anchor: |offset| < |d| whenever progress < len.
 */
export function legOffset(d: number, progress: number, len: number): number {
  const mag = Math.floor((Math.abs(d) * progress) / len);
  return d < 0 ? -mag : mag;
}

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
        if (u.legLen < 0) {
          // LEG START: anchor where the unit stands; the length is fixed for the leg.
          u.legX = u.x;
          u.legY = u.y;
          u.legProgress = 0;
          const ldx = wp.x - u.x;
          const ldy = wp.y - u.y;
          u.legLen = isqrt(ldx * ldx + ldy * ldy);
        }
        const left = u.legLen - u.legProgress;
        if (left <= remaining) {
          // ARRIVAL: land exactly on the waypoint, consume it, carry the surplus on.
          u.x = wp.x;
          u.y = wp.y;
          remaining -= left;
          u.waypoints.shift();
          u.legLen = -1;
          moved = true;
          continue;
        }
        // Scale the leg's integer direction vector: anchor + d × progress / len, the
        // magnitude floored (toward the anchor) so the unit never lands on the waypoint
        // before the leg's length is spent — floor toward −∞ on a negative d could.
        const dx = wp.x - u.legX;
        const dy = wp.y - u.legY;
        const progress = u.legProgress + remaining;
        const nx = clamp(u.legX + legOffset(dx, progress, u.legLen), 0, maxX) as Fixed;
        const ny = clamp(u.legY + legOffset(dy, progress, u.legLen), 0, maxY) as Fixed;
        if (!isFree(state.grid, cellOf({ x: nx, y: ny })) || !losClear(state.grid, { x: u.x, y: u.y }, { x: nx, y: ny })) {
          // Unreachable by construction (LOS_LEG_MARGIN + parametric legs; the probe's
          // `cannotHappen` counter watches it). If it ever fires: stand, drop the leg and
          // re-plan from here rather than clip through a cell.
          u.legLen = -1;
          u.pathDirty = true;
          break;
        }
        u.legProgress = progress;
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
