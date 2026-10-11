/**
 * Phase 5 — posted-unit aggro, leash pursuit and disengage-and-return (chunk 11), with the
 * three defensive stances fixed in chunk 07 QA D1. Posted units are visited in ASCENDING
 * UNIT ID; each one reads the attackers' positions AFTER this tick's phase 3 movement.
 *
 * STANCES (never change mid-fight). A stance drives MOVEMENT and ACQUISITION only; every
 * stance fires in phase 6 at the nearest attacker in reach (combat.ts, chunk 11 QA D1):
 *   guard   — the behaviour below. The default.
 *   hold    — never leaves its post (leash 0, no pursuit, no return); phase 6 hits whatever
 *             is within its reach measured from where it stands, which is its post.
 *   reserve — does not acquire and does not move (it still fires back at an attacker in
 *             reach) until an attacker is INSIDE THE RING: the lowest-id living attacker
 *             whose lattice cell has Chebyshev distance < PERIMETER_RING_RADIUS from the core
 *             centre cell (strictly inside the square the fence sits on; a ring cell itself —
 *             a gap — does not count, so a breacher standing on the ring cell releases it one
 *             cell later, by design). From that tick on, in that same phase, it behaves
 *             exactly as `guard`, and it never reverts (`released`).
 *
 * GUARD STATE MACHINE (`postMode`), evaluated top to bottom every tick:
 *   pursuing → returning  when, in this order: the target is dead (`why: "dead"`); the unit
 *                         is beyond its leash from its POST (`"leash"`, LEASH_BOUNDARY_RULE:
 *                         the leash is INCLUSIVE — distSq ≤ leashSq is still engaged, one
 *                         unit further disengages; with LEASH_CLAMP below this check is
 *                         defensive); the target is outside the unit's aggro reach measured
 *                         from the UNIT's current position (`"lost"`).
 *   idle → pursuing       when a living attacker is within aggro reach (AGGRO_TIE_BREAK:
 *                         nearest by squared distance, lowest id on a tie). Aggro reach is
 *                         aggroRadius + unitRadius (REACH rule), squared.
 *   returning → pursuing  only once the unit is back within LEASH_HYSTERESIS × leash of its
 *                         post (inclusive), by the same acquisition rule. Until then it is
 *                         deaf to aggro (DISENGAGE_BEHAVIOR). Any disengage — including one
 *                         caused by the target dying — goes through `returning`, so a guard
 *                         that kills its target beyond the hysteresis radius walks back first.
 *   returning → idle      when it stands exactly on its post position (`returned`).
 * AGGRO_HYSTERESIS (QA-11 B1b): the attacker last dropped as `lost` (`lostTarget`) is
 * re-acquired only within LEASH_HYSTERESIS × aggro reach (`aggroHysteresisSq`, inclusive);
 * every other attacker keeps the full aggro reach. Re-acquiring it clears the memory; a
 * later `lost` overwrites it.
 *
 * Movement: a pursuing unit whose target is within its attack reach holds still (engaged);
 * otherwise it walks a lattice route to the target's current position, a returning unit a
 * route to its post. Routes are planned with `findPath` and NO breach edges (a posted unit
 * never breaks the caravan's own fence) and string-pulled like an attacker's, ending on the
 * exact goal position; they are recomputed on the same cadence as attackers' (every
 * pathRecomputeInterval ticks, on a mode or target change, and on the tick after a fence
 * breaks).
 * PURSUIT_ROUTE_BOUND (QA-11 B1a): a pursuit route counts only if every waypoint before the
 * final one (the turning points of a detour) is within the unit's leash of its post AND
 * within its aggro reach of the target's current position. Distance to a fixed point is
 * convex along a straight leg, so no detour leg then leaves either radius; the final leg
 * runs straight at the target (its distance to the target only shrinks) and is the one leg
 * that may meet the leash, where LEASH_CLAMP stops it. A route that fails the bound is NO
 * ROUTE, the same as a target sealed off by fence: the unit stands in `pursuing`, keeps its
 * target, fires if it comes within reach and retries on the next recompute; it neither
 * disengages nor re-acquires, so there is no per-tick acquire/drop chatter.
 * LEASH_CLAMP (QA-11 N1): a pursuing unit never steps past its leash. If this tick's full
 * step would end beyond it, the step is shortened to the largest integer budget that ends
 * within it (a binary search re-running the same leg rule from a snapshot; pure), and the
 * unit disengages `leash` in the same phase — it has hit the leash limit — so it never
 * stands, or fires, from beyond its leash. A step that ends EXACTLY on the leash is not
 * clamped (inclusive leash). Oscillation at the leash boundary stays bounded: after a leash
 * disengage the unit walks at least (1 − hysteresis) × leash back before it can re-acquire.
 */
import { CORE_CENTER_CELL, PERIMETER_RING_RADIUS, cellOf, type FixedPoint } from "./battlefield.js";
import { unitDistSq } from "./combat.js";
import { COST_INFINITE } from "./fixed.js";
import type { LogEvent } from "./log.js";
import { advance, effectiveSpeed, tickEffects } from "./move.js";
import { LOS_LEG_MARGIN, findPath, losClear, smoothPath, type Waypoint } from "./path.js";
import type { SimState, UnitState } from "./state.js";

const noBreach = (): number => COST_INFINITE;

function distSqToPost(u: UnitState): number {
  const dx = u.x - u.postX;
  const dy = u.y - u.postY;
  return dx * dx + dy * dy;
}

/** The lowest-id living attacker standing strictly inside the ring, or −1. */
export function attackerInsideRing(state: SimState): number {
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive) continue;
    const c = cellOf({ x: u.x, y: u.y });
    const dx = Math.abs(c.x - CORE_CENTER_CELL.x);
    const dy = Math.abs(c.y - CORE_CENTER_CELL.y);
    if ((dx > dy ? dx : dy) < PERIMETER_RING_RADIUS) return id;
  }
  return -1;
}

/**
 * AGGRO_TIE_BREAK: nearest living attacker within aggro reach of `u`, lowest id on a tie; −1
 * if none. AGGRO_HYSTERESIS: the attacker last dropped as `lost` counts only within the
 * hysteresis aggro reach.
 */
export function acquireTarget(state: SimState, u: UnitState): number {
  let best = -1;
  let bestD = 0;
  for (let id = 0; id < state.attackerCount; id++) {
    const v = state.units[id]!;
    if (!v.alive) continue;
    const d = unitDistSq(u, v);
    if (d > (id === u.lostTarget ? u.aggroHysteresisSq : u.aggroSq)) continue;
    if (best < 0 || d < bestD) {
      best = id;
      bestD = d;
    }
  }
  return best;
}

/**
 * A breach-free route from the unit to the exact `goal` position (see header). Null when
 * no such route exists. The final waypoint is the goal itself: the last cell-centre
 * waypoint is replaced by it when the leg stays clear, else the goal is appended (centre →
 * goal lies inside one cell, so that leg is always clear).
 */
export function planPostedRoute(state: SimState, u: UnitState, goal: FixedPoint): Waypoint[] | null {
  const from: FixedPoint = { x: u.x, y: u.y };
  const steps = findPath(state.grid, cellOf(from), cellOf(goal), noBreach);
  if (steps === null) return null;
  const route = smoothPath(state.grid, from, steps);
  const end: Waypoint = { x: goal.x, y: goal.y, breach: -1 };
  if (route.length === 0) {
    if (goal.x !== from.x || goal.y !== from.y) route.push(end);
    return route;
  }
  const last = route[route.length - 1]!;
  if (last.x === goal.x && last.y === goal.y) return route;
  const prev: FixedPoint = route.length >= 2 ? route[route.length - 2]! : from;
  if (losClear(state.grid, prev, goal, LOS_LEG_MARGIN)) route[route.length - 1] = end;
  else route.push(end);
  return route;
}

function setMode(u: UnitState, mode: UnitState["postMode"]): void {
  u.postMode = mode;
  u.pathDirty = true;
  u.waypoints = [];
  u.legLen = -1;
}

function disengage(state: SimState, u: UnitState, why: "leash" | "lost" | "dead", log: LogEvent[]): void {
  log.push({ t: state.tick, k: "disengage", u: u.id, why });
  if (why === "lost" && u.target !== null && u.target.kind === "unit") u.lostTarget = u.target.id;
  u.target = null;
  setMode(u, "returning");
}

function tryAcquire(state: SimState, u: UnitState, log: LogEvent[]): void {
  const v = acquireTarget(state, u);
  if (v < 0) return;
  u.target = { kind: "unit", id: v };
  if (v === u.lostTarget) u.lostTarget = -1;
  setMode(u, "pursuing");
  log.push({ t: state.tick, k: "aggro", u: u.id, v });
}

function distSq(a: FixedPoint, b: FixedPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * PURSUIT_ROUTE_BOUND (see header): every waypoint before the last is within the leash of
 * the post and within aggro reach of `goal` (the target's position).
 */
export function pursuitRouteInBounds(u: UnitState, route: readonly Waypoint[], goal: FixedPoint): boolean {
  const post: FixedPoint = { x: u.postX, y: u.postY };
  for (let i = 0; i < route.length - 1; i++) {
    const wp = route[i]!;
    if (distSq(wp, post) > u.leashSq || distSq(wp, goal) > u.aggroSq) return false;
  }
  return true;
}

/** Re-plan the route to `goal` if due; log it when it changed. `pursuit` applies PURSUIT_ROUTE_BOUND. */
function routeTo(state: SimState, u: UnitState, goal: FixedPoint, pursuit: boolean, log: LogEvent[]): void {
  const due = state.tick % state.pathRecomputeInterval === 0 || u.pathDirty;
  if (!due) return;
  u.pathDirty = false;
  let route = planPostedRoute(state, u, goal);
  if (route !== null && pursuit && !pursuitRouteInBounds(u, route, goal)) route = null;
  if (route === null) {
    if (u.waypoints.length > 0) {
      u.waypoints = [];
      u.legLen = -1;
      log.push({ t: state.tick, k: "path", u: u.id, speed: u.speedInForce, wp: [] });
    }
    return;
  }
  let same = route.length === u.waypoints.length;
  for (let i = 0; same && i < route.length; i++) same = route[i]!.x === u.waypoints[i]!.x && route[i]!.y === u.waypoints[i]!.y;
  if (same) return;
  u.waypoints = route;
  u.legLen = -1;
  log.push({ t: state.tick, k: "path", u: u.id, speed: u.speedInForce, wp: route.map((w) => [w.x, w.y, w.breach] as const) });
}

/**
 * LEASH_CLAMP (see header): advance a pursuing unit by `budget`, shortened if needed so it
 * ends within its leash. Returns whether it moved and whether the clamp bound. The unit
 * starts within its leash (the pursuing checks ran first), so budget 0 is always feasible;
 * the search keeps the largest feasible budget it probes, which is deterministic.
 */
function advanceWithinLeash(state: SimState, u: UnitState, budget: number): { moved: boolean; clamped: boolean } {
  const x = u.x;
  const y = u.y;
  const waypoints = u.waypoints.slice();
  const legX = u.legX;
  const legY = u.legY;
  const legLen = u.legLen;
  const legProgress = u.legProgress;
  const pathDirty = u.pathDirty;
  const sweepLen = u.sweep.length;
  const restore = (): void => {
    u.x = x;
    u.y = y;
    u.waypoints = waypoints.slice();
    u.legX = legX;
    u.legY = legY;
    u.legLen = legLen;
    u.legProgress = legProgress;
    u.pathDirty = pathDirty;
    u.sweep.length = sweepLen;
  };
  const moved = advance(state, u, budget);
  if (distSqToPost(u) <= u.leashSq) return { moved, clamped: false };
  let lo = 0;
  let hi = budget - 1;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo + 1) / 2);
    restore();
    advance(state, u, mid);
    if (distSqToPost(u) <= u.leashSq) lo = mid;
    else hi = mid - 1;
  }
  restore();
  return { moved: lo > 0 && advance(state, u, lo), clamped: true };
}

/** The guard behaviour for one tick. Returns whether the unit moved. */
function guard(state: SimState, u: UnitState, log: LogEvent[]): boolean {
  if (u.postMode === "pursuing") {
    const t = u.target;
    const v = t !== null && t.kind === "unit" ? state.units[t.id]! : null;
    if (v === null || !v.alive) disengage(state, u, "dead", log);
    else if (distSqToPost(u) > u.leashSq) disengage(state, u, "leash", log);
    else if (unitDistSq(u, v) > u.aggroSq) disengage(state, u, "lost", log);
  }
  if (u.postMode === "idle") tryAcquire(state, u, log);
  else if (u.postMode === "returning" && distSqToPost(u) <= u.hysteresisSq) tryAcquire(state, u, log);

  if (u.postMode === "pursuing") {
    const v = state.units[(u.target as { id: number }).id]!;
    if (unitDistSq(u, v) <= u.reachSq) {
      // Engaged: in reach, no route needed.
      u.waypoints = [];
      u.legLen = -1;
      return false;
    }
    routeTo(state, u, { x: v.x, y: v.y }, true, log);
    const step = advanceWithinLeash(state, u, effectiveSpeed(u));
    if (step.clamped) disengage(state, u, "leash", log);
    return step.moved;
  }
  if (u.postMode === "returning") {
    routeTo(state, u, { x: u.postX, y: u.postY }, false, log);
    const moved = advance(state, u, effectiveSpeed(u));
    if (u.x === u.postX && u.y === u.postY) {
      setMode(u, "idle");
      u.pathDirty = false;
      log.push({ t: state.tick, k: "returned", u: u.id });
    }
    return moved;
  }
  return false;
}

export function postedUnitPhase(state: SimState, log: LogEvent[]): void {
  for (let id = state.attackerCount; id < state.units.length; id++) {
    const u = state.units[id]!;
    if (!u.alive) continue;
    u.sweep = [{ x: u.x, y: u.y }];
    let moved = false;
    if (u.postStance === "reserve" && !u.reserveReleased) {
      const v = attackerInsideRing(state);
      if (v >= 0) {
        u.reserveReleased = true;
        log.push({ t: state.tick, k: "released", u: id, v });
      }
    }
    if (u.postStance === "guard" || (u.postStance === "reserve" && u.reserveReleased)) moved = guard(state, u, log);
    tickEffects(state, u, log);
    const holding = !moved;
    if (holding !== u.holding) {
      u.holding = holding;
      log.push({ t: state.tick, k: "hold", u: id, holding });
    }
  }
}
