/**
 * Ability DATA shapes (chunk 03). Resolution is chunk 12 and has exactly six cases — one
 * per archetype below. Per-unit variation is values only; there is deliberately no field
 * on any shape that could carry a proc chance, a random target, or a variance roll.
 *
 * Every living-unit type has exactly one ability (TUNABLES.ABILITIES_PER_UNIT_TYPE). It
 * fires automatically the first tick its cooldown is ready AND its targeting condition is
 * satisfiable; the first use waits a full cooldown (TUNABLES.ABILITY_FIRST_USE_DELAY_MULT),
 * except a structure breaker's, which waits a quarter of it
 * (TUNABLES.STRUCTURE_BREAKER_FIRST_USE_MULT, chunk 12 QA D2). Every description ends with
 * its "First use after X s." line, and `abilityDisplay` gives the scout view the same
 * numbers ready to print (GUARDRAILS §4).
 *
 * NO ability field scales with merge level (TUNABLES.MERGE_MULT_SCALES_ABILITY_FIELDS is
 * false; chunk 03 QA S1). The merge multiplier applies to max HP and to post-formula
 * damage output only, so a damage-multiplier ability (heavy strike = ×N of ONE hit) is
 * already carried by the merged unit's larger hit; a heal is a fraction of the target's
 * (already merged) max HP; radii, distances, durations and charges are the same at every
 * level. A second multiplier here would be a second, hidden power curve (GUARDRAILS §2).
 * Merge level never changes the archetype either.
 *
 * All distances are Fixed cells, all durations are Millis, all multipliers are Fixed
 * (FIXED_ONE = ×1.0). See fixedPoint.ts.
 */
import { FIXED_POINT_SCALE, type Fixed, type Millis } from "./fixedPoint.js";
import { deepFreeze } from "./freeze.js";
import { TUNABLES } from "./tunables.js";

export const ABILITY_ARCHETYPES = deepFreeze([
  "burst_radius",
  "heavy_strike",
  "heal_radius",
  "self_buff",
  "dash",
  "structure_breaker",
] as const);
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
 * the start of each encounter. No overheal, no revival (chunk 12 healer rules); a heal never
 * raises a unit above the HP it brought into the battle (the resolver's HEAL_CEILING), so
 * damage carried forward from earlier encounters is never healed.
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

/**
 * Archetype 6: one hit on an adjacent fence segment for `fenceDamageMult` × a normal hit.
 * Additive with siege. Like every fence hit it obeys TUNABLES.FENCE_HIT_SEGMENT_CAP: one unit
 * takes at most half a segment's max HP from it per tick, its normal hit and this one summed.
 */
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

// ── display-ready numbers (chunk 12 QA S5) ─────────────────────────────────────────────

/**
 * `n / d` rounded half up to `places` (0, 1 or 2) decimals, as a plain decimal string with
 * trailing zeros dropped: "10", "2.85", "4.5". Integer arithmetic only; n ≥ 0, d > 0.
 */
export function decimalString(n: number, d: number, places: 0 | 1 | 2): string {
  const scale = places === 0 ? 1 : places === 1 ? 10 : 100;
  const v = Math.floor((n * scale * 2 + d) / (2 * d));
  const whole = Math.floor(v / scale);
  let frac = String(v - whole * scale).padStart(places, "0");
  while (frac.endsWith("0")) frac = frac.slice(0, -1);
  return frac.length > 0 ? `${whole}.${frac}` : String(whole);
}

/**
 * An ability's numbers exactly as a player should read them (GUARDRAILS §4). Every field is
 * a display-ready decimal string (no unit, no sign) or null where the archetype has no such
 * number. Distances in cells, durations in seconds, percentages as whole percent.
 *   cooldownSeconds    the cooldown.
 *   firstUseSeconds    when it can first fire: the cooldown × ABILITY_FIRST_USE_DELAY_MULT,
 *                      or × STRUCTURE_BREAKER_FIRST_USE_MULT for a breaker, on the resolver's
 *                      tick grid (floor(cooldownTicks × mult) ticks).
 *   reachCells         how far from the caster's centre a target's centre may be:
 *                      radius + UNIT_RADIUS for burst / heal (the REACH rule), attack range +
 *                      UNIT_RADIUS for heavy strike / self buff (its normal attack reach);
 *                      null for dash (the caster) and structure breaker (the adjacent segment).
 *   damageMultiplier   × a normal hit (burst, strike; the breaker's fence multiplier before
 *                      siege is added).
 *   healPercent        % of the TARGET's max HP restored per cast.
 *   healCeiling        "start_of_fight_hp": a heal never raises a unit above the HP it brought
 *                      into this fight (damage carried in from earlier encounters is never
 *                      healed). null for every other archetype.
 *   charges            heal casts per fight (never refilled).
 *   buffPercent        +% damage while the buff is in force; buffSeconds its length.
 *   dashCells          how far a dash carries the caster along its path.
 *   fenceHitCapPercent the most one unit takes from one segment per tick, % of its max HP
 *                      (FENCE_HIT_SEGMENT_CAP — every unit's rule; stated on the breaker).
 * Percentages round to the nearest whole percent: content authors them in thousandths and
 * the stored 1/1024 value is within 0.1 point of what was authored (fpMilli(100) = 102/1024 =
 * 9.96 % reads "10").
 */
export interface AbilityDisplay {
  readonly archetype: AbilityArchetype;
  readonly cooldownSeconds: string;
  readonly firstUseSeconds: string;
  readonly reachCells: string | null;
  readonly damageMultiplier: string | null;
  readonly healPercent: string | null;
  readonly healCeiling: "start_of_fight_hp" | null;
  readonly charges: number | null;
  readonly buffPercent: string | null;
  readonly buffSeconds: string | null;
  readonly dashCells: string | null;
  readonly fenceHitCapPercent: string | null;
}

/** The ability's first use in milliseconds, on the resolver's tick grid (see AbilityDisplay). */
export function abilityFirstUseMs(ability: Ability): number {
  const tickRate = TUNABLES.TICK_RATE;
  const cooldownTicks = Math.max(1, Math.floor((ability.cooldown * tickRate) / 1000));
  const mult = ability.archetype === "structure_breaker" ? TUNABLES.STRUCTURE_BREAKER_FIRST_USE_MULT : TUNABLES.ABILITY_FIRST_USE_DELAY_MULT;
  const ticks = Math.floor((cooldownTicks * mult) / FIXED_POINT_SCALE);
  return Math.floor((ticks * 1000) / tickRate);
}

/** Display-ready numbers for `ability` on a unit whose attack range is `attackRange`. */
export function abilityDisplay(ability: Ability, attackRange: Fixed): AbilityDisplay {
  const cells = (v: number): string => decimalString(v, FIXED_POINT_SCALE, 2);
  const pct = (v: number): string => decimalString(v * 100, FIXED_POINT_SCALE, 0);
  const secs = (v: number): string => decimalString(v, 1000, 2);
  const a = ability;
  const reach =
    a.archetype === "burst_radius" || a.archetype === "heal_radius"
      ? cells(a.radius + TUNABLES.UNIT_RADIUS)
      : a.archetype === "heavy_strike" || a.archetype === "self_buff"
        ? cells(attackRange + TUNABLES.UNIT_RADIUS)
        : null;
  return {
    archetype: a.archetype,
    cooldownSeconds: secs(a.cooldown),
    firstUseSeconds: secs(abilityFirstUseMs(a)),
    reachCells: reach,
    damageMultiplier:
      a.archetype === "burst_radius" || a.archetype === "heavy_strike" ? cells(a.damageMult) : a.archetype === "structure_breaker" ? cells(a.fenceDamageMult) : null,
    healPercent: a.archetype === "heal_radius" ? pct(a.healFraction) : null,
    healCeiling: a.archetype === "heal_radius" ? "start_of_fight_hp" : null,
    charges: a.archetype === "heal_radius" ? a.charges : null,
    buffPercent: a.archetype === "self_buff" ? pct(a.damageBonus) : null,
    buffSeconds: a.archetype === "self_buff" ? secs(a.duration) : null,
    dashCells: a.archetype === "dash" ? cells(a.distance) : null,
    fenceHitCapPercent: a.archetype === "structure_breaker" ? pct(TUNABLES.FENCE_HIT_SEGMENT_CAP) : null,
  };
}
