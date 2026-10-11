/**
 * Continuous movement along a route, shared by attackers (phase 3, tick.ts) and posted
 * units (phase 5, posted.ts) since chunk 11. The leg rule is chunk 10's (MOVEMENT_LEG,
 * QA-10 S2/N1): a unit advances PARAMETRICALLY along its current leg — position = leg anchor
 * + sign(d) × floor(|d| × progress / len) per axis — never by re-aiming from its last
 * rounded position, and it lands exactly on a waypoint when the leg's remaining length fits
 * the tick's budget.
 *
 * EFFECTS (chunk 11): a trap's slow or root changes the per-tick budget, not the leg:
 *   effective speed = 0 while rooted; otherwise speedPerTick − floor(speedPerTick ×
 *   slowMagnitude) while slowed; otherwise speedPerTick.
 * An effect applied in phase 4 of tick t is in force for the movement of ticks
 * t+1 .. t+durationTicks: `tickEffects` runs AFTER the tick's movement and counts the
 * remaining ticks down, so a 30-tick root removes exactly 30 ticks of movement. A second
 * effect of the same kind REFRESHES rather than stacks: remaining = max(remaining, new),
 * magnitude = max(magnitude, new) (EFFECT_STACKING). Whenever the effective speed changes
 * a `speed` event is logged (in force from the next tick's movement — log.ts).
 *
 * SWEEP: `advance` records the polyline the unit traced this tick (start, every waypoint it
 * landed on, end) in `u.sweep`, so phase 4's trap test can intersect the true path, corner
 * turns included, rather than the start→end chord.
 */
import { FIELD_HEIGHT, FIELD_WIDTH, cellOf, type Fixed } from "./battlefield.js";
import { clamp, isqrt, legOffset, scaleInt } from "./fixed.js";
import type { LogEvent } from "./log.js";
import { losClear } from "./path.js";
import { isFree, type SimState, type UnitState } from "./state.js";

/** The leg rule's per-axis offset lives in fixed.ts (shared with the replay reader, which must not import the simulation). */
export { legOffset } from "./fixed.js";

/** The per-tick budget in force for this unit's next movement (see EFFECTS). */
export function effectiveSpeed(u: UnitState): number {
  if (u.rootRemaining > 0) return 0;
  if (u.slowRemaining > 0) return u.speedPerTick - scaleInt(u.speedPerTick, u.slowMagnitude);
  return u.speedPerTick;
}

/** Log a `speed` event if the effective speed differs from the one last in force. */
export function syncSpeed(state: SimState, u: UnitState, log: LogEvent[]): void {
  const now = effectiveSpeed(u);
  if (now === u.speedInForce) return;
  u.speedInForce = now;
  log.push({ t: state.tick, k: "speed", u: u.id, speed: now });
}

/** Count this tick's effect ticks down, after the movement they governed. */
export function tickEffects(state: SimState, u: UnitState, log: LogEvent[]): void {
  if (u.rootRemaining > 0) u.rootRemaining--;
  if (u.slowRemaining > 0) {
    u.slowRemaining--;
    if (u.slowRemaining === 0) u.slowMagnitude = 0 as Fixed;
  }
  syncSpeed(state, u, log);
}

/**
 * Advance `u` along its waypoints with `budget` fixed units of movement. Returns whether
 * it moved. Stops short of a waypoint whose breach fence is intact (sets `u.breaching`;
 * only attackers ever carry breach waypoints) and, defensively, before any step that would
 * land in a blocked cell or cross one (QA-10 S2: unreachable by construction; the unit
 * drops its leg and re-plans). Appends every point it lands on to `u.sweep`.
 */
export function advance(state: SimState, u: UnitState, budget: number): boolean {
  return advanceMeasured(state, u, budget).moved;
}

/**
 * `advance`, also returning how much of the budget was spent (`used`, fixed units along the
 * route). A phase-7 dash logs `used` so a replay advances the unit by exactly that distance
 * with the same leg rule (log.ts INTERPOLATION CONTRACT, `ability` / dash).
 */
export function advanceMeasured(state: SimState, u: UnitState, budget: number): { moved: boolean; used: number } {
  const maxX = FIELD_WIDTH - 1;
  const maxY = FIELD_HEIGHT - 1;
  let remaining = budget;
  let moved = false;
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
      u.sweep.push({ x: u.x, y: u.y });
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
    u.sweep.push({ x: u.x, y: u.y });
  }
  return { moved, used: budget - remaining };
}
