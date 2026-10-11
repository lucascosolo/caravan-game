/**
 * Phase hooks for chunks 11–12 (chunk 10 TICK_PHASE_ORDER). Chunk 10 fixes the order of
 * the eight phases in tick.ts and leaves phases 4, 5 and 7 as these explicit no-ops so
 * later chunks fill a named seam rather than re-deriving the order. They receive the whole
 * state and the log; they must stay pure, integer-only and id-ordered like everything else.
 *
 * Also here: the SIEGE / FENCE-DAMAGE seam the chunk 10 brief asks for ("siege equipment
 * accelerates or bypasses this against its countered fence category — values are chunk 11;
 * the hook belongs here").
 */
import type { LogEvent } from "./log.js";
import type { FenceState, SimState, UnitState } from "./state.js";
import { FIXED_ONE, scaleInt, type Fixed } from "./fixed.js";

/** Phase 4 — trap triggers (swept-path intersection, fire once, spend). TODO(chunk-11). */
export function trapTriggerPhase(_state: SimState, _log: LogEvent[]): void {
  // no-op in chunk 10
}

/** Phase 5 — posted-unit aggro acquisition, leash pursuit, disengage-and-return. TODO(chunk-11). */
export function postedUnitPhase(_state: SimState, _log: LogEvent[]): void {
  // no-op in chunk 10
}

/** Phase 7 — ability cooldowns and effects, six archetypes. TODO(chunk-12). */
export function abilityPhase(_state: SimState, _log: LogEvent[]): void {
  // no-op in chunk 10
}

/**
 * Siege multiplier on a unit's hit against a fence segment. TODO(chunk-11): return
 * SIEGE_FENCE_DAMAGE_MULT (from the input tunables) when the party carries a siege piece
 * whose `counters` is {kind: "fence", category: fence.category}; the structure_breaker
 * ability is ADDITIVE with it, not multiplicative (chunk 12). Chunk 10 returns ×1.0.
 */
export function siegeFenceMult(_state: SimState, _unit: UnitState, _fence: FenceState): Fixed {
  return FIXED_ONE;
}

/**
 * Damage of one breach hit by `unit` on `fence` (FENCE_BREACH rule, chunk 10).
 *
 * A fence segment has no defense rating, so chunk 11's formula offense² / (offense +
 * defense) with defense = 0 reduces to `offense`: one breach hit deals the unit's offense
 * rating, times the siege multiplier, floored. Chunk 11 keeps this consistent with its
 * unit-vs-unit formula; chunk 12 adds the structure_breaker term. Never below 1 so a
 * breach always terminates (no deadlock against an intact segment).
 */
export function fenceHitDamage(state: SimState, unit: UnitState, fence: FenceState): number {
  const d = scaleInt(unit.offense, siegeFenceMult(state, unit, fence));
  return d < 1 ? 1 : d;
}

/**
 * End-of-tick end-condition check. TODO(chunk-13): return "party_wiped" when no attacker
 * is alive and "core_overrun" when an attacker has reached the core. Chunk 10 never ends
 * early: the loop runs to the tick cap and `reachedCoreTick` is recorded per unit.
 */
export function endOfTick(_state: SimState): "party_wiped" | "core_overrun" | null {
  return null;
}
