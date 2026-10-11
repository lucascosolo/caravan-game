/**
 * Phase 4 — trap triggers (chunk 11).
 *
 * TRAP_TRIGGER_TEST (swept-segment intersection): a trap fires when the polyline an
 * attacker swept THIS tick (`u.sweep`: start-of-tick position, every waypoint it landed
 * on, end position — move.ts) comes within TRAP reach of the trap's centre, where reach =
 * trapTriggerRadius + unitRadius (REACH rule) and the test is on squared distance. Because
 * the whole path is tested, not the landing position, a unit fast enough to cross the trap
 * entirely between two ticks still triggers it (no tunnelling), and a unit that turned a
 * waypoint corner through the radius triggers it too. A unit that did not move this tick
 * is tested as a point (a one-point sweep). Posted units never trigger the caravan's own
 * traps: only attackers are tested.
 *
 * The closest point of a segment to the trap is computed in integers: the parametric
 * offset `legOffset(d, dot, |d|²)` floors the projection toward the segment's start, so
 * the tested point is within one fixed unit (per axis) of the exact closest point. That
 * rounding is part of the rule — it is deterministic, documented and the same everywhere.
 *
 * TRAP_TIE_BREAK: attackers are visited in ASCENDING UNIT ID and, for each, unspent traps
 * in ascending trap index. Two units crossing the same trap on the same tick: the lower id
 * springs it and takes the effect; the trap is spent before the higher id is tested, so
 * exactly one unit is hit. One unit crossing two traps on the same tick springs both.
 *
 * TRAP_FIRE: the trap is SPENT the moment it is sprung, whatever happens next. If the party
 * carries a siege piece countering the trap's category (SIEGE_TRAP_NULLIFY), it fires blank:
 * `trap_nullified`, no damage, no effect — and it is still spent (not preserved for the
 * next attacker). Otherwise damage = max(1, floor(trap.damage × affinity multiplier for
 * trap.affinity vs the unit's affinity)) (combat.ts DAMAGE_ROUNDING_ORDER steps 2 and 5;
 * traps have no formula, no merge level, no siege step), HP floors at 0 and the unit dies
 * in phase 8 — it still acts in phases 5–7 of this tick (SIMULTANEOUS_DAMAGE). TRAP_SKIPS_ZERO_HP
 * (QA-11 N2): an attacker already at 0 HP (killed by an earlier trap this phase) is not
 * tested again, so a second trap on its path is not spent on a corpse. The effect,
 * if any, is applied with its duration converted to ticks (msToTicks) and refreshes rather
 * than stacks (move.ts EFFECT_STACKING).
 *
 * A trap target (`traps` stance) becomes invalid when spent; phase 1 of the next tick
 * retargets the attacker.
 */
import type { FixedPoint } from "./battlefield.js";
import { affinityMult, atLeastOne } from "./combat.js";
import { scaleInt } from "./fixed.js";
import type { LogEvent } from "./log.js";
import { legOffset, syncSpeed } from "./move.js";
import { msToTicks, type SimState, type TrapState, type UnitState } from "./state.js";

/** Squared distance from `p` to the segment a→b, via the floored closest point (see header). */
export function segmentDistSq(p: FixedPoint, a: FixedPoint, b: FixedPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const dd = dx * dx + dy * dy;
  if (dd === 0) return wx * wx + wy * wy;
  const dot = wx * dx + wy * dy;
  if (dot <= 0) return wx * wx + wy * wy;
  if (dot >= dd) {
    const ex = p.x - b.x;
    const ey = p.y - b.y;
    return ex * ex + ey * ey;
  }
  const cx = a.x + legOffset(dx, dot, dd);
  const cy = a.y + legOffset(dy, dot, dd);
  const ox = p.x - cx;
  const oy = p.y - cy;
  return ox * ox + oy * oy;
}

/** Whether a sweep polyline comes within reachSq of `p`. */
export function sweepCrosses(sweep: readonly FixedPoint[], p: FixedPoint, reachSq: number): boolean {
  if (sweep.length === 0) return false;
  if (sweep.length === 1) return segmentDistSq(p, sweep[0]!, sweep[0]!) <= reachSq;
  for (let i = 1; i < sweep.length; i++) if (segmentDistSq(p, sweep[i - 1]!, sweep[i]!) <= reachSq) return true;
  return false;
}

function fireTrap(state: SimState, trap: TrapState, u: UnitState, log: LogEvent[]): void {
  trap.spent = true;
  trap.spentTick = state.tick;
  if (trap.siegeCountered) {
    log.push({ t: state.tick, k: "trap_nullified", i: trap.index, u: u.id });
    return;
  }
  const damage = atLeastOne(scaleInt(trap.damage, affinityMult(state, trap.affinity, u.affinity)));
  u.hp = u.hp - damage < 0 ? 0 : u.hp - damage;
  let applied: "slow" | "root" | null = null;
  const effect = trap.effect;
  if (effect !== null) {
    const ticks = msToTicks(effect.duration, state.tickRate);
    if (effect.kind === "slow") {
      if (ticks > u.slowRemaining) u.slowRemaining = ticks;
      if (effect.magnitude > u.slowMagnitude) u.slowMagnitude = effect.magnitude;
    } else if (ticks > u.rootRemaining) u.rootRemaining = ticks;
    applied = effect.kind;
    syncSpeed(state, u, log);
  }
  log.push({ t: state.tick, k: "trap_fired", i: trap.index, u: u.id, damage, hp: u.hp, effect: applied });
}

/**
 * Test one attacker's current sweep against every unspent trap, ascending trap index, with
 * every rule above (TRAP_TRIGGER_TEST, TRAP_SKIPS_ZERO_HP, TRAP_FIRE, SIEGE_TRAP_NULLIFY).
 * Phase 4 calls it for each attacker in ascending id; phase 7 calls it for an attacker's
 * dash polyline right after the dash (abilities.ts DASH_SPRINGS_TRAPS).
 */
export function springTraps(state: SimState, u: UnitState, log: LogEvent[]): void {
  for (const trap of state.traps) {
    if (u.hp === 0) break; // TRAP_SKIPS_ZERO_HP
    if (trap.spent) continue;
    if (sweepCrosses(u.sweep, trap.pos, state.trapReachSq)) fireTrap(state, trap, u, log);
  }
}

export function trapTriggerPhase(state: SimState, log: LogEvent[]): void {
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive) continue;
    springTraps(state, u, log);
  }
}
