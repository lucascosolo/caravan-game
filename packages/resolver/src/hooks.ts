/**
 * Phase hooks (chunk 10 TICK_PHASE_ORDER). Chunk 10 fixed the order of the eight phases in
 * tick.ts and left phases 4, 5 and 7 as named seams. Chunk 11 fills 4 (traps.ts) and 5
 * (posted.ts); chunk 12 fills 7 (abilities.ts); `endOfTick` (end conditions) is chunk 13's.
 * Every hook receives the whole state and the log and stays pure, integer-only and
 * id-ordered like everything else.
 *
 * Also here: the SIEGE / FENCE-DAMAGE seam the chunk 10 brief asked for.
 */
import { atLeastOne, dealtOutput, fenceHitRoom } from "./combat.js";
import type { FenceState, SimState, UnitState } from "./state.js";
import { FIXED_ONE, scaleInt, type Fixed } from "./fixed.js";

export { trapTriggerPhase } from "./traps.js";
export { postedUnitPhase } from "./posted.js";

export { abilityPhase } from "./abilities.js";

/**
 * SIEGE_FENCE_DAMAGE_MULT (chunk 11): when the party carries a siege piece whose `counters`
 * is {kind: "fence", category: fence.category}, every hit on that segment is multiplied by
 * the input's siegeFenceDamageMult (×4 by default); otherwise ×1.0. Siege is a COUNTER to
 * fences and traps only — it never touches a hit on a unit (combat.ts), and it is decided
 * per fence category, not per unit. The structure_breaker ability (chunk 12) is ADDITIVE
 * with this multiplier, never multiplicative (abilities.ts STRUCTURE_BREAKER_DAMAGE).
 */
export function siegeFenceMult(state: SimState, _unit: UnitState, fence: FenceState): Fixed {
  return fence.siegeCountered ? state.siegeFenceDamageMult : FIXED_ONE;
}

/**
 * Damage of one breach hit by `unit` on `fence` (FENCE_BREACH rule; combat.ts
 * DAMAGE_SLOTS / DAMAGE_ROUNDING_ORDER). A fence segment has no rating, so the formula
 * o² / (o + 0) reduces to the unit's rating (its offense). Then, in order: no affinity (a
 * segment has none), × the unit's merge multiplier (damage output scales with merge level,
 * chunk 03 QA B1) and its self buff while in force (chunk 12, step 3b; one floor for the
 * two), × the siege multiplier, floored, minimum 1 so a breach always terminates (no
 * deadlock against an intact segment) — then clipped to FENCE_HIT_SEGMENT_CAP (combat.ts
 * step 6): never more than the room left of the unit's per-tick allowance on this segment.
 * Phase 6 lands at most one fence hit per unit per tick and runs before phase 7, so there
 * the room is always the whole cap (≥ 1); route planning (phase 2) prices breaches with the
 * same capped hit.
 */
export function fenceHitDamage(state: SimState, unit: UnitState, fence: FenceState): number {
  const merged = dealtOutput(state, unit, unit.rating);
  const hit = atLeastOne(scaleInt(merged, siegeFenceMult(state, unit, fence)));
  const room = fenceHitRoom(state, unit, fence);
  return hit < room ? hit : room;
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
