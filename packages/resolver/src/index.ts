/**
 * @caravan/resolver — the deterministic simulation (chunks 10–13).
 *
 * Pure: zero dependencies, no I/O, no clock, no RNG, no floats, no Map/Set. Enforced by
 * eslint.config.js and scripts/resolver-boundary-check.mjs. Everything is fixed-point
 * integer arithmetic (fixed.ts). The client never runs this; it renders the returned log.
 *
 * Chunk 10: battlefield geometry (owned here, re-exported by @caravan/circle), the input
 * contract, the fixed-timestep tick loop, lattice A* + string pulling, continuous movement,
 * fence breaching, and the start of the tick log. Chunk 11: cooldown-paced damage with the
 * affinity layer, swept-path traps, posted-unit stances / aggro / leash, siege counters,
 * unit death. Abilities are chunk 12, end conditions and the replay format chunk 13.
 */
export { RESOLVER_VERSION } from "./version.js";
export * from "./fixed.js";
export * from "./battlefield.js";
export * from "./input.js";
export * from "./path.js";
export * from "./log.js";
export { resolve, type EndReason, type FenceSummary, type ResolveOutput, type TrapSummary, type UnitSummary } from "./resolve.js";
export { type FenceState, type PostMode, type SimState, type Side, type Target, type TrapState, type UnitState, initialState, msToTicks, speedPerTick } from "./state.js";
export { runTick, retargetPhase, pathPhase, movementPhase, attackPhase, deathPhase, breachCostFor, legOffset, planRoute, routeCost } from "./tick.js";
export { fenceHitDamage, siegeFenceMult, trapTriggerPhase, postedUnitPhase, abilityPhase, endOfTick } from "./hooks.js";
export { affinityMult, formulaDamage, hitDamage, nearestEnemyInReach, canAttack, unitDistSq } from "./combat.js";
export { advance, effectiveSpeed, tickEffects } from "./move.js";
export { segmentDistSq, sweepCrosses } from "./traps.js";
export { acquireTarget, attackerInsideRing, planPostedRoute } from "./posted.js";
