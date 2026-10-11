/**
 * Phase hooks (chunk 10 TICK_PHASE_ORDER). Chunk 10 fixed the order of the eight phases in
 * tick.ts and left phases 4, 5 and 7 as named seams. Chunk 11 fills 4 (traps.ts) and 5
 * (posted.ts); 7 (abilities) is chunk 12's and `endOfTick` (end conditions) chunk 13's.
 * Every hook receives the whole state and the log and stays pure, integer-only and
 * id-ordered like everything else.
 *
 * Also here: the SIEGE / FENCE-DAMAGE seam the chunk 10 brief asked for.
 */
import { atLeastOne } from "./combat.js";
import type { LogEvent } from "./log.js";
import type { FenceState, SimState, UnitState } from "./state.js";
import { FIXED_ONE, scaleInt, type Fixed } from "./fixed.js";

export { trapTriggerPhase } from "./traps.js";
export { postedUnitPhase } from "./posted.js";

/** Phase 7 — ability cooldowns and effects, six archetypes. TODO(chunk-12). */
export function abilityPhase(_state: SimState, _log: LogEvent[]): void {
  // no-op until chunk 12
}

/**
 * SIEGE_FENCE_DAMAGE_MULT (chunk 11): when the party carries a siege piece whose `counters`
 * is {kind: "fence", category: fence.category}, every hit on that segment is multiplied by
 * the input's siegeFenceDamageMult (×4 by default); otherwise ×1.0. Siege is a COUNTER to
 * fences and traps only — it never touches a hit on a unit (combat.ts), and it is decided
 * per fence category, not per unit. TODO(chunk-12): the structure_breaker ability is
 * ADDITIVE with this multiplier, not multiplicative.
 */
export function siegeFenceMult(state: SimState, _unit: UnitState, fence: FenceState): Fixed {
  return fence.siegeCountered ? state.siegeFenceDamageMult : FIXED_ONE;
}

/**
 * Damage of one breach hit by `unit` on `fence` (FENCE_BREACH rule; combat.ts
 * DAMAGE_SLOTS / DAMAGE_ROUNDING_ORDER). A fence segment has no rating, so the formula
 * o² / (o + 0) reduces to the unit's rating (its offense). Then, in order: no affinity (a
 * segment has none), × the unit's merge multiplier (damage output scales with merge level,
 * chunk 03 QA B1), × the siege multiplier, floored at each step, minimum 1 so a breach
 * always terminates (no deadlock against an intact segment).
 */
export function fenceHitDamage(state: SimState, unit: UnitState, fence: FenceState): number {
  const merged = scaleInt(unit.rating, unit.mergeMult);
  return atLeastOne(scaleInt(merged, siegeFenceMult(state, unit, fence)));
}

/**
 * End-of-tick end-condition check. TODO(chunk-13): return "party_wiped" when no attacker
 * is alive and "core_overrun" when an attacker has reached the core. Until then the loop
 * never ends early: it runs to the tick cap, with `reachedCoreTick` and `diedTick`
 * recorded per unit.
 */
export function endOfTick(_state: SimState): "party_wiped" | "core_overrun" | null {
  return null;
}
