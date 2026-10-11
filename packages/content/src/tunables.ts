/**
 * TUNABLES REGISTRY — every balance constant in the game lives here, never inline in game
 * logic (AGENTS.md "Working rules"; chunk 03 definition of done). Later chunks import from
 * here; a grep for magic numbers in game logic should come back clean.
 *
 * Every entry is a PROPOSED DEFAULT from a chunk brief and is TUNABLE unless its comment
 * says "fixed by design". Each comment names what would drive a change. Nothing here has
 * been balanced against play data.
 *
 * Numerics: fractional values are fixed-point integers (`Fixed`, 1/1024 units) and
 * durations are whole milliseconds (`Millis`). See fixedPoint.ts — that is the single
 * place the scale is defined. No float literal appears in this file or any content file;
 * a test asserts it.
 */
import { FIXED_ONE, fp, fpMilli, ms, seconds, type Fixed, type Millis } from "./fixedPoint.js";

/**
 * Merge-level stat curve. Index = merge level (index 0 unused; levels are 1..5).
 * Authored as a table, not computed, so the stored values are the diffable truth.
 * Each level is ×1.6 the previous (fpMilli(1600) = 1638/1024 ≈ 1.5996), compounding:
 *   L1 1.000  L2 1.600  L3 2.560  L4 4.096  L5 6.554
 *
 * TUNABLE — but bounded by a guardrail, not a preference (GUARDRAILS §2): a merged unit
 * must be WEAKER than its components combined, for BOTH recipes (PROJECT.md §7):
 *   2 → 1 : S(L+1) < 2 × S(L)         ⇒ per-level multiplier < 2.0
 *   5 → 3 : 3 × S(L+1) < 5 × S(L)     ⇒ per-level multiplier < 1.667
 * The chunk brief proposed ×1.8, which satisfies the first but NOT the second (3 × 1.8 =
 * 5.4 > 5): the 5→3 recipe would have been a net power gain. ×1.6 is the default here so
 * that both recipes are slot-efficiency gains only. A test checks both bounds at every level.
 * Caveat for balancing: HP and damage both scale by this factor, so a merged unit's
 * HP × DPS product scales by its square (2.56); whether that matters depends on the
 * damage formula's sub-linearity and is for play data to settle.
 */
const MERGE_STAT_MULT_BY_LEVEL: readonly Fixed[] = [
  0 as Fixed, // level 0 does not exist
  FIXED_ONE, // L1 ×1.000
  fpMilli(1600), // L2 ×1.600
  fpMilli(2560), // L3 ×2.560
  fpMilli(4096), // L4 ×4.096
  fpMilli(6554), // L5 ×6.554
];

export const TUNABLES = {
  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 01 — account / caravan / region scale
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (chunk 01). Number of selectable regions; must equal REGIONS.length. */
  REGION_COUNT: 4,

  /** TUNABLE (chunk 01, PROJECT.md §14). Per-account Coin storage cap. Pure placeholder. */
  COIN_STORAGE_CAP: 50_000,

  /**
   * TUNABLE (chunk 01). v1 enforcement value only — app logic refuses a second caravan,
   * but the schema supports N caravans per account (GUARDRAILS §5).
   */
  MAX_CARAVANS_PER_ACCOUNT: 1,

  /** TUNABLE (chunk 04). Neutral starting Reputation for every pool. A rating, never spent. */
  REPUTATION_START: 1000,

  /** Merge cap is level 5 for everyone (GUARDRAILS §2). Fixed by design, not a balance knob. */
  MERGE_LEVEL_MIN: 1,
  MERGE_LEVEL_MAX: 5,

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 03 — content scale. Driven by MVP web size and how much a player can learn.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE. Living-unit types per region; the per-region unlock web size. Tests assert the roster matches. */
  LIVING_UNITS_PER_REGION: 8,
  /** TUNABLE. Universal trap types (one node each in the trap web). */
  TRAP_TYPES: 6,
  /** TUNABLE. Universal siege types; each counters exactly one fence or trap category. */
  SIEGE_TYPES: 5,
  /** TUNABLE. Fence tiers available via the trap web (chunk 05: 4 fence-tier nodes). */
  FENCE_TIERS: 4,
  /** TUNABLE within the design's 2–4 range (PROJECT.md §11). Must equal AFFINITY_CATEGORIES.length. */
  AFFINITY_CATEGORIES: 3,
  /** Fixed by design (chunk 12 scope). Exactly one ability per living-unit type. */
  ABILITIES_PER_UNIT_TYPE: 1,
  /** Fixed by design (chunk 12 scope). The resolver has six ability cases, no more. */
  ABILITY_ARCHETYPE_COUNT: 6,

  // ────────────────────────────────────────────────────────────────────────────────────
  // Combat math (PROJECT.md §11, chunk 11)
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Fixed by design (PROJECT.md §11). Documented here so nobody re-derives it; chunk 11
   * implements it in fixed-point with floor rounding. An attacker's `offense` and a posted
   * unit's `defense` fill the offense slot for the damage THEY deal.
   */
  DAMAGE_FORMULA: "offense * offense / (offense + defense)",
  /** TUNABLE. Damage multiplier on a favourable affinity matchup (×1.25). Driven by how much the layer should matter vs. raw stats. */
  AFFINITY_ADVANTAGE_MULT: fpMilli(1250),
  /** TUNABLE. Damage multiplier on an unfavourable matchup (×0.80 → 819/1024 ≈ 0.7998). */
  AFFINITY_DISADVANTAGE_MULT: fpMilli(800),
  /** Neutral multiplier is exactly ×1.0. Not a knob — it is the identity. */
  AFFINITY_NEUTRAL_MULT: FIXED_ONE,
  /** See the table comment above. Index by merge level 1..5. */
  MERGE_STAT_MULT_BY_LEVEL,
  /** Authored spread of base offense ratings across the roster; a test asserts every unit is inside it. TUNABLE. */
  BASE_OFFENSE_MIN: 40,
  BASE_OFFENSE_MAX: 120,
  /** Same spread for defense, authored INDEPENDENTLY per type — a test asserts no fixed ratio. TUNABLE. */
  BASE_DEFENSE_MIN: 40,
  BASE_DEFENSE_MAX: 120,
  /** TUNABLE. Max HP spread; needed because damage is cooldown-paced, not per-tick. */
  UNIT_HP_MIN: 300,
  UNIT_HP_MAX: 1400,

  // ────────────────────────────────────────────────────────────────────────────────────
  // Unit behaviour defaults — per-type overrides are the norm; these are the reference
  // values and the bounds the roster is authored within. Distances in Fixed cells, speeds
  // in Fixed cells/second, times in ms. The resolver converts to per-tick quantities.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (PROJECT.md §9). How close an attacker must come for a posted unit to notice. 4.0 cells. */
  AGGRO_RADIUS_DEFAULT: fp(4),
  /** TUNABLE (PROJECT.md §9). How far a posted unit chases from its post before returning. 6.0 cells. */
  LEASH_DISTANCE_DEFAULT: fp(6),
  /** TUNABLE. 1.5 cells/second. Roster range below. Driven by fight pacing vs. the tick cap. */
  MOVE_SPEED_DEFAULT: fpMilli(1500),
  MOVE_SPEED_MIN: fpMilli(800),
  MOVE_SPEED_MAX: fp(3),
  /** TUNABLE. Range is the only thing that makes a unit melee or ranged — no separate flag. */
  ATTACK_RANGE_MELEE_DEFAULT: fp(1),
  ATTACK_RANGE_RANGED_DEFAULT: fp(4),
  /** TUNABLE. One hit per cooldown expiry (NOT per tick). 1.0 s; roster range 0.4–2.5 s. DPS = hit / cooldown. */
  ATTACK_COOLDOWN_DEFAULT: seconds(1),
  ATTACK_COOLDOWN_MIN: ms(400),
  ATTACK_COOLDOWN_MAX: ms(2500),

  // ────────────────────────────────────────────────────────────────────────────────────
  // Abilities (chunk 12 resolves; chunk 03 authors the data)
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE. Ability cooldowns are long relative to attacks so a firing is a visible beat. */
  ABILITY_COOLDOWN_MIN: seconds(6),
  ABILITY_COOLDOWN_MAX: seconds(20),
  /**
   * TUNABLE (rule, not number). Units don't open with their ability: the first use waits
   * the full cooldown. Expressed as a multiplier on the ability's cooldown (×1.0).
   */
  ABILITY_FIRST_USE_DELAY_MULT: FIXED_ONE,
  /** Fixed by design: fires the moment cooldown is ready AND the target condition is satisfiable. No chance, no input. */
  ABILITY_TRIGGER_RULE: "ready_and_satisfiable",
  /** TUNABLE (chunk 12). Archetype reference values; per-type abilities vary around them. */
  BURST_RADIUS_DEFAULT: fp(2),
  HEAVY_STRIKE_MULT_DEFAULT: fp(3),
  HEAL_RADIUS_DEFAULT: fpMilli(2500),
  /** ×0.10 of target max HP per cast, all valid targets in radius. Percentage so it scales across the roster. */
  HEAL_FRACTION_DEFAULT: fpMilli(100),
  /** THE load-bearing bound on healing (chunk 12): finite, non-regenerating charges per battle. Reset, not accumulated, per encounter. */
  HEAL_CHARGES_PER_BATTLE: 4,
  HEAL_COOLDOWN_DEFAULT: seconds(14),
  /** +0.30 damage for 5 s. Non-stacking with itself; refresh resets the timer (chunk 12 documents). */
  SELF_BUFF_DAMAGE_BONUS_DEFAULT: fpMilli(300),
  SELF_BUFF_DURATION_DEFAULT: seconds(5),
  DASH_DISTANCE_DEFAULT: fp(3),
  /** ×5.0 vs. fence segments only. ADDITIVE with siege, never multiplicative (chunk 12). */
  STRUCTURE_BREAKER_MULT_DEFAULT: fp(5),

  // ────────────────────────────────────────────────────────────────────────────────────
  // Traps / siege / fences (chunks 07 and 11 consume)
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE. Flat, single-trigger trap damage spread; a test asserts every trap is inside it. */
  TRAP_DAMAGE_MIN: 60,
  TRAP_DAMAGE_MAX: 250,
  /** TUNABLE (chunk 11). Swept-path trigger radius around a trap's cell centre. 0.75 cells. */
  TRAP_TRIGGER_RADIUS: fpMilli(750),
  /** TUNABLE (chunk 11). Slow effect: −0.40 move speed for 3 s. */
  TRAP_SLOW_MAGNITUDE_DEFAULT: fpMilli(400),
  TRAP_SLOW_DURATION_DEFAULT: seconds(3),
  /** TUNABLE (chunk 11). Root effect: no movement for 1.5 s. */
  TRAP_ROOT_DURATION_DEFAULT: ms(1500),
  /** TUNABLE (chunk 07). Reference fence HP — the tier-2 segment. Per-tier values live in FENCE_TIERS data. */
  FENCE_SEGMENT_HP_DEFAULT: 400,
  /** TUNABLE. Siege vs. its countered FENCE category: ×4 damage to segments ("accelerates"). */
  SIEGE_FENCE_DAMAGE_MULT: fp(4),
  /** Fixed by design (PROJECT.md §3): siege vs. its countered TRAP category fully nullifies the trap ("bypasses"); the trap is still spent (chunk 11). */
  SIEGE_TRAP_NULLIFY: true,
  /** TUNABLE (chunk 07). Living units a caravan can carry on a trip — the blast-radius cap on loss (GUARDRAILS "Bounded stakes"). */
  DEPLOYMENT_SLOT_CAP: 8,
  /** TUNABLE (chunk 07). Traps carried per trip; consumed as they fire. */
  TRAP_SLOT_CAP: 6,

  // ────────────────────────────────────────────────────────────────────────────────────
  // Merge recipes (PROJECT.md §7). Fixed by design; listed so the guardrail test can read them.
  // ────────────────────────────────────────────────────────────────────────────────────
  MERGE_RECIPES: [
    { spend: 2, produce: 1 },
    { spend: 5, produce: 3 },
  ],
} as const;

export type Tunables = typeof TUNABLES;

/** Convenience: the merge multiplier for a level, throwing on an out-of-range level. */
export function mergeStatMult(level: number): Fixed {
  if (!Number.isInteger(level) || level < TUNABLES.MERGE_LEVEL_MIN || level > TUNABLES.MERGE_LEVEL_MAX) {
    throw new RangeError(`merge level ${String(level)} is outside ${TUNABLES.MERGE_LEVEL_MIN}..${TUNABLES.MERGE_LEVEL_MAX}`);
  }
  return TUNABLES.MERGE_STAT_MULT_BY_LEVEL[level] as Fixed;
}

/** The affinity multiplier for an outcome, read from the registry. */
export function affinityMult(outcome: "advantage" | "neutral" | "disadvantage"): Fixed {
  switch (outcome) {
    case "advantage":
      return TUNABLES.AFFINITY_ADVANTAGE_MULT;
    case "disadvantage":
      return TUNABLES.AFFINITY_DISADVANTAGE_MULT;
    case "neutral":
      return TUNABLES.AFFINITY_NEUTRAL_MULT;
  }
}

// Re-exported so consumers needing the unit types can import from the registry module.
export type { Fixed, Millis };
