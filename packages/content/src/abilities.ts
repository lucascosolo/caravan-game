/**
 * Ability DATA shapes (chunk 03). Resolution is chunk 12 and has exactly six cases — one
 * per archetype below. Per-unit variation is values only; there is deliberately no field
 * on any shape that could carry a proc chance, a random target, or a variance roll.
 *
 * Every living-unit type has exactly one ability (TUNABLES.ABILITIES_PER_UNIT_TYPE). It
 * fires automatically the first tick its cooldown is ready AND its targeting condition is
 * satisfiable; the first use waits a full cooldown (TUNABLES.ABILITY_FIRST_USE_DELAY_RULE).
 * Merge level scales the numeric values below on the same sub-linear curve as stats and
 * never changes the archetype (GUARDRAILS §2).
 *
 * All distances are Fixed cells, all durations are Millis, all multipliers are Fixed
 * (FIXED_ONE = ×1.0). See fixedPoint.ts.
 */
import type { Fixed, Millis } from "./fixedPoint.js";

export const ABILITY_ARCHETYPES = [
  "burst_radius",
  "heavy_strike",
  "heal_radius",
  "self_buff",
  "dash",
  "structure_breaker",
] as const;
export type AbilityArchetype = (typeof ABILITY_ARCHETYPES)[number];

interface AbilityBase {
  /** Player-facing name — abilities are previewable in the scout view (GUARDRAILS §4). */
  readonly displayName: string;
  /** One line, player-facing, says what it does in plain words. */
  readonly description: string;
  /** Time between firings, in ms. First use waits this long too. */
  readonly cooldown: Millis;
}

/** Archetype 1: damage every enemy within `radius` of the caster for `damageMult` × one normal hit. */
export interface BurstRadiusAbility extends AbilityBase {
  readonly archetype: "burst_radius";
  readonly radius: Fixed;
  readonly damageMult: Fixed;
}

/** Archetype 2: one hit on the current attack target for `damageMult` × a normal hit. */
export interface HeavyStrikeAbility extends AbilityBase {
  readonly archetype: "heavy_strike";
  readonly damageMult: Fixed;
}

/**
 * Archetype 3: restore `healFraction` of max HP to every living ally within `radius`.
 * Bounded by `charges` per battle — finite, non-regenerating, reset (not accumulated) at
 * the start of each encounter. No overheal, no revival (chunk 12 healer rules).
 */
export interface HealRadiusAbility extends AbilityBase {
  readonly archetype: "heal_radius";
  readonly radius: Fixed;
  readonly healFraction: Fixed;
  readonly charges: number;
}

/** Archetype 4: caster's own hits deal +`damageBonus` for `duration`. Non-stacking with itself. */
export interface SelfBuffAbility extends AbilityBase {
  readonly archetype: "self_buff";
  readonly damageBonus: Fixed;
  readonly duration: Millis;
}

/** Archetype 5: move `distance` cells along the current path at once. Cannot cross an intact fence. */
export interface DashAbility extends AbilityBase {
  readonly archetype: "dash";
  readonly distance: Fixed;
}

/** Archetype 6: one hit on an adjacent fence segment for `fenceDamageMult` × a normal hit. Additive with siege. */
export interface StructureBreakerAbility extends AbilityBase {
  readonly archetype: "structure_breaker";
  readonly fenceDamageMult: Fixed;
}

export type Ability =
  | BurstRadiusAbility
  | HeavyStrikeAbility
  | HealRadiusAbility
  | SelfBuffAbility
  | DashAbility
  | StructureBreakerAbility;

export function isAbilityArchetype(value: unknown): value is AbilityArchetype {
  return typeof value === "string" && (ABILITY_ARCHETYPES as readonly string[]).includes(value);
}
