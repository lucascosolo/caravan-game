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
import { FIXED_ONE, fp, fpMilli, fpRatio, ms, seconds, type Fixed, type Millis } from "./fixedPoint.js";
import { deepFreeze } from "./freeze.js";

/**
 * Merge-level multiplier table. Index = merge level (index 0 unused; levels are 1..5).
 * Authored as a table, not computed, so the stored values are the diffable truth.
 * Each level is ×1.25 the previous (MERGE_MULT_PER_LEVEL = 1280/1024, exact), compounding:
 *   L1 1.000  L2 1.250  L3 1.5625  L4 1.953  L5 2.441   (1024, 1280, 1600, 2000, 2500)
 *
 * ── SEMANTICS (chunk 03 QA round 1, item B1 — this changed; consumers read carefully) ──
 * The multiplier applies LINEARLY to exactly the things in MERGE_MULT_APPLIES_TO below:
 *   • "hp"            — max HP = scaleInt(type.hp, mult(level)).
 *   • "damage_output" — each hit = scaleInt(floor(o² / (o + d)), mult(level)), i.e. the
 *                       multiplier is applied AFTER the damage formula, to its output.
 * It is NEVER applied to the offense or defense RATINGS that enter the formula: ratings are
 * the unmerged type values at every merge level. It also never touches any ability field
 * (see MERGE_MULT_SCALES_ABILITY_FIELDS): a merged unit's larger hit already carries
 * damage-multiplier abilities, heals are a fraction of the target's (already merged) HP,
 * and radii, distances, durations and charges are fixed. Earlier the table was ×1.6 on
 * the ratings themselves; under o²/(o+d) that was super-linear and a net power gain.
 *
 * TUNABLE — but bounded by a guardrail, not a preference (GUARDRAILS §2): a merged unit
 * must be WEAKER than its components combined, for BOTH recipes (PROJECT.md §7). With the
 * multiplier k on both HP and damage output, effective strength (HP × damage per hit)
 * scales by k² per level, so the bounds are:
 *   2 → 1 : k² < 2        ⇒ k < 1.414
 *   5 → 3 : 3 k² < 5      ⇒ k² < 5/3, k < 1.291   ← THE ceiling that must never be crossed.
 * k = 1.25 gives k² = 1.5625 < 1.667. A test computes HP × actual damage per hit for every
 * unit type against every roster opponent (every affinity outcome, floor rounding and all)
 * and asserts produced < spent at every level for both recipes.
 */
const MERGE_STAT_MULT_BY_LEVEL: readonly Fixed[] = [
  0 as Fixed, // level 0 does not exist
  FIXED_ONE, // L1 ×1.000      (1024)
  fpRatio(5, 4), // L2 ×1.25    (1280)
  fpRatio(25, 16), // L3 ×1.5625 (1600)
  fpRatio(125, 64), // L4 ×1.953  (2000)
  fpRatio(625, 256), // L5 ×2.441  (2500)
];

/**
 * Registry keys that are REFERENCE DEFAULTS a content type may override per type (chunk 03
 * QA S5). Where a type's value IS the default, the content file references the key rather
 * than re-authoring the literal, so re-tuning the default re-tunes every type that didn't
 * deliberately deviate; a test enforces that on the healers and the trap effects. Keys not
 * listed here are either hard bounds, counts, or global rules — never overridden per type.
 */
const PER_TYPE_OVERRIDABLE_DEFAULTS = [
  "AGGRO_RADIUS_DEFAULT",
  "LEASH_DISTANCE_DEFAULT",
  "MOVE_SPEED_DEFAULT",
  "ATTACK_RANGE_MELEE_DEFAULT",
  "ATTACK_RANGE_RANGED_DEFAULT",
  "ATTACK_COOLDOWN_DEFAULT",
  "BURST_RADIUS_DEFAULT",
  "HEAVY_STRIKE_MULT_DEFAULT",
  "HEAL_RADIUS_DEFAULT",
  "HEAL_FRACTION_DEFAULT",
  "HEAL_COOLDOWN_DEFAULT",
  "SELF_BUFF_DAMAGE_BONUS_DEFAULT",
  "SELF_BUFF_DURATION_DEFAULT",
  "DASH_DISTANCE_DEFAULT",
  "STRUCTURE_BREAKER_MULT_DEFAULT",
  "TRAP_SLOW_MAGNITUDE_DEFAULT",
  "TRAP_SLOW_DURATION_DEFAULT",
  "TRAP_ROOT_DURATION_DEFAULT",
] as const;

/**
 * Chunk 04 — cumulative ladder points to stand on rung n (index = rung, 0..20). The
 * authored integer form of floor(100 × n^1.5); see TUNABLES.LADDER_POINTS_TO_RUNG.
 */
const LADDER_POINTS_TO_RUNG: readonly number[] = [
  0, // rung 0: the starting state
  100, 282, 519, 800, 1118, 1469, 1852, 2262, 2700, 3162, // rungs 1–10
  3648, 4156, 4687, 5238, 5809, 6400, 7009, 7636, 8281, 8944, // rungs 11–20
];

/** Chunk 04 — unlock points granted on first reaching rung n (index = rung, 0 unused). */
const UNLOCK_POINTS_BY_RUNG: readonly number[] = [
  0, // rung 0 grants nothing
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // rungs 1–10
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, // rungs 11–20
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
  /** TUNABLE. Universal siege types; each counters exactly one fence or trap category, so this must equal FENCE_CATEGORY_COUNT + TRAP_CATEGORY_COUNT (validated on load). */
  SIEGE_TYPES: 5,
  /** TUNABLE. Fence categories (timber / wire / stone); must equal FENCE_CATEGORIES.length. */
  FENCE_CATEGORY_COUNT: 3,
  /** TUNABLE. Trap categories (groundwork / powder); must equal TRAP_CATEGORIES.length. */
  TRAP_CATEGORY_COUNT: 2,
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
  /**
   * TUNABLE. Damage multiplier on an unfavourable matchup (×0.80 → 819/1024 ≈ 0.7998).
   * NOTE: advantage × disadvantage ≠ 1 exactly (1280 × 819 / 1024² ≈ 0.9998, and 1.25 × 0.80
   * = 1.0 only in the decimal authoring). That is intentional: the two are independent
   * knobs, not reciprocals, and nothing may assume a round trip cancels out.
   */
  AFFINITY_DISADVANTAGE_MULT: fpMilli(800),
  /** Neutral multiplier is exactly ×1.0. Not a knob — it is the identity. */
  AFFINITY_NEUTRAL_MULT: FIXED_ONE,
  /**
   * See the table comment above. Index by merge level 1..5. Applies LINEARLY to the things
   * in MERGE_MULT_APPLIES_TO and nothing else — never to the ratings in the formula.
   */
  MERGE_STAT_MULT_BY_LEVEL,
  /** The per-level step of the table above (×1.25 = 1280/1024, exact). The table is the authority; this is the authoring value. */
  MERGE_MULT_PER_LEVEL: fpRatio(5, 4),
  /**
   * Fixed by design (chunk 03 QA B1). WHAT the merge multiplier applies to, as data, so the
   * resolver (chunks 11/12) and the circle manifest (chunk 07) apply it in exactly these
   * places: max HP, and each hit's damage AFTER the o²/(o+d) formula. Anything not listed
   * — the offense/defense ratings, speed, range, cooldowns, aggro, leash, ability values —
   * is the unmerged type value at every level. Tests assert the list is exactly this.
   */
  MERGE_MULT_APPLIES_TO: ["hp", "damage_output"],
  /** Fixed by design (chunk 03 QA S1). No ability field scales with merge level — not multipliers, radii, fractions, durations, distances or charges. */
  MERGE_MULT_SCALES_ABILITY_FIELDS: false,
  /** The merge multiplier never touches these; listed so a consumer can assert it. Fixed by design. */
  MERGE_MULT_NEVER_APPLIES_TO: ["offense", "defense", "moveSpeed", "attackRange", "attackCooldown", "aggroRadius", "leashDistance", "ability"],
  /**
   * Fixed by design (GUARDRAILS §2): the ceiling on the per-level multiplier squared. The
   * 5→3 recipe demands 3 k² < 5. Expressed as a ratio so the test can read it from the
   * registry rather than re-deriving it: the table must satisfy k² < MERGE_EFFECTIVE_CEILING.
   */
  MERGE_EFFECTIVE_CEILING: fpRatio(5, 3),
  /** See PER_TYPE_OVERRIDABLE_DEFAULTS above the registry. */
  PER_TYPE_OVERRIDABLE_DEFAULTS,
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
  // Chunk 16 — Coin economy and merge pricing. Coin buys PACE only (GUARDRAILS §2): nothing
  // here reaches a stat, a resolution rule, or the merge cap. Plain integer Coin amounts.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (chunk 16). Coin for surviving the FIRST encounter of a trip. Later encounters escalate (below). */
  COIN_PER_ENCOUNTER_BASE: 400,
  /** TUNABLE (chunk 16). ×1.25 per subsequent encounter, compounding, floored each step (ties to chunk 15's escalation). */
  COIN_ENCOUNTER_ESCALATION_MULT: fpMilli(1250),
  /** TUNABLE (chunk 16). Flat completion bonus on a banked trip — the delivery reward. */
  COIN_PER_BANKED_TRIP: 500,
  /** TUNABLE (chunk 16). When your standing party overruns a caravan. Deliberately below the active path: playing pays better than not playing. */
  COIN_PER_PARTY_WIN: 300,
  /**
   * TUNABLE (chunk 16). Passive trickle, 200 Coin per hour, ceasing at the storage cap.
   * Computed lazily on read from the last accrual point (no background tick). The server
   * accrues in whole coins every COIN_TRICKLE_MS_PER_COIN ms; the two values must agree
   * (3_600_000 == RATE_PER_HOUR × MS_PER_COIN — a server test asserts it). Change both.
   */
  COIN_TRICKLE_RATE_PER_HOUR: 200,
  COIN_TRICKLE_MS_PER_COIN: 18_000,
  /**
   * TUNABLE (chunk 16). Coin cost of a merge, indexed by the RESULTING level (index 0 and 1
   * unused: nothing produces a level-1 unit). Cost is PER RESULTING UNIT, so 5→3 at the same
   * target level costs three times 2→1. Steeply escalating — THE pacing lever.
   */
  MERGE_COST_BY_TARGET_LEVEL: [0, 0, 250, 900, 3_000, 9_500],
  /** Fixed by design (chunk 16). A unit occupies one deployment slot at any merge level — the entire benefit of merging. */
  MERGE_SLOT_COST: 1,
  /** Fixed by design (chunk 16). Earnings above the cap are discarded, and the player is warned before the trip, never silently. */
  COIN_OVERFLOW_BEHAVIOR: "discard_with_warning",

  // ────────────────────────────────────────────────────────────────────────────────────
  // Merge recipes (PROJECT.md §7). Fixed by design; listed so the guardrail test can read them.
  // ────────────────────────────────────────────────────────────────────────────────────
  MERGE_RECIPES: [
    { spend: 2, produce: 1 },
    { spend: 5, produce: 3 },
  ],

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 04 — ladders and Reputation. Two SEPARATE numbers per pool (PROJECT.md §5):
  // the permanent, use-driven ladder that grants unlock points at rungs, and the volatile
  // Reputation rating that drives matchmaking. Neither is derived from the other. Every
  // number here is read by apps/server/src/progression; nothing there is inline.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (chunk 04). Ladder depth per pool. A capped ladder earns no further progress. */
  LADDER_RUNGS_PER_POOL: 20,
  /**
   * TUNABLE (chunk 04). CUMULATIVE ladder points needed to stand on rung n, indexed by rung
   * (index 0 = rung 0 = nothing). Authored as a table, like the merge curve, so the stored
   * integers are the diffable truth: floor(100 × n^1.5). Rung 1 = 100, rung 10 = 3162,
   * rung 20 = 8944. Points never reset on a crossing; the ladder is monotone by construction.
   * Must be strictly increasing with LADDER_RUNGS_PER_POOL + 1 entries (a test asserts it).
   */
  LADDER_POINTS_TO_RUNG,
  /** TUNABLE (chunk 04). Ladder points for the attacking party's owner when the party overruns a caravan, per pool used (siege). */
  LADDER_GAIN_WIN: 30,
  /** TUNABLE (chunk 04). Ladder points for a LOST encounter, per pool used, on either side. Must be > 0 and < every win-side gain: losses still earn. */
  LADDER_GAIN_LOSS: 10,
  /** TUNABLE (chunk 04). The attacking party's owner's gain on a stalemate (treated as a loss for the party). */
  LADDER_GAIN_STALEMATE: 10,
  /** TUNABLE (chunk 04). The caravan's gain, per pool used (living, trap), when its circle repels a party — held OR stalemate (both count as the caravan prevailing). The active side's main ladder path. */
  LADDER_GAIN_DEFENSE_HELD: 25,
  /**
   * TUNABLE (chunk 04). Unlock points granted the FIRST (and only) time a ladder reaches
   * rung n, indexed by rung (index 0 unused). 1 for rungs 1–10, 2 for rungs 11–20: 30 per
   * pool at cap, which chunk 05's NODE_COST_CURVE is sized against.
   */
  UNLOCK_POINTS_BY_RUNG,
  /** TUNABLE (chunk 04). Reputation gained by the party's owner when their party overruns a caravan, before gap scaling. */
  REPUTATION_WIN_ATTACKER: 25,
  /** TUNABLE (chunk 04). Reputation lost by the party's owner when their party is wiped or withdraws (stalemate), before gap scaling. */
  REPUTATION_LOSS_ATTACKER: -15,
  /** TUNABLE (chunk 04). Reputation gained by the caravan when it holds (party wiped) or the party withdraws (stalemate), before gap scaling. */
  REPUTATION_CARAVAN_HELD: 15,
  /** TUNABLE (chunk 04). Reputation lost by the caravan when it is overrun, before gap scaling. */
  REPUTATION_CARAVAN_OVERRUN: -20,
  /** TUNABLE (chunk 04). Reputation cannot fall below this; a loss that would cross it is clamped (and recorded as clamped). */
  REPUTATION_FLOOR: 100,
  /**
   * TUNABLE (chunk 04). The Elo-ish gap scaling, integer-only. For a rating gap g =
   * opponent − self: a win is scaled by (1 + g / DIVISOR), a loss by (1 − g / DIVISOR),
   * each clamped to [MULT_MIN, MULT_MAX]. Beating someone DIVISOR above you doubles the
   * gain; losing to someone DIVISOR below you doubles the loss. Blunts sandbagging
   * (PHASE-2 §28): farming far-weaker parties pays a quarter of the base gain at most.
   */
  REPUTATION_GAP_DIVISOR: 400,
  REPUTATION_GAP_MULT_MIN: fpMilli(250),
  REPUTATION_GAP_MULT_MAX: fp(2),
} as const;

// Deep-frozen on export (chunk 03 QA S2): no consumer can mutate a balance value at runtime.
// `as const` only narrows the TYPE; this makes assignment throw in strict-mode code too.
deepFreeze(TUNABLES);

export type Tunables = typeof TUNABLES;

/**
 * Convenience: the merge multiplier for a level, throwing on an out-of-range level.
 * Apply it ONLY to the things in TUNABLES.MERGE_MULT_APPLIES_TO (max HP and post-formula
 * damage output) — see the table comment.
 */
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
