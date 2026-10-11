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

  /**
   * TUNABLE (chunk 04; chunk 37 balance pass 1000 → 400, BALANCE-LOG.md). Neutral starting
   * Reputation for every pool. A rating, never spent. 400 is the bottom of display band 1, so a
   * new caravan's encounter 1 (this + FIRST_ENCOUNTER_CENTRE_OFFSET = 250) is searched in band 0,
   * the unmerged starter outfits, and everything above is room to climb.
   */
  REPUTATION_START: 400,

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
  BASE_DEFENSE_MIN: 60,
  BASE_DEFENSE_MAX: 160,
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
  /**
   * TUNABLE (chunk 11, LEASH_HYSTERESIS). A posted unit that disengaged at its leash must be
   * back within this fraction of its leash distance from its post (×0.80) before it may
   * re-acquire. Prevents per-tick chattering at the boundary; the leash itself is INCLUSIVE
   * (exactly at the leash is still engaged).
   */
  LEASH_HYSTERESIS_MULT: fpMilli(800),
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
  /**
   * TUNABLE (chunk 12 QA D2). The structure breaker's first use waits this fraction of its
   * cooldown (×0.25 — a 12 s breaker first swings 3 s in) instead of
   * ABILITY_FIRST_USE_DELAY_MULT: a breaker reaches its fence early, and with the full delay it
   * rarely fired before the fence was down. FENCE_HIT_SEGMENT_CAP keeps an early swing safe.
   */
  STRUCTURE_BREAKER_FIRST_USE_MULT: fpMilli(250),
  /**
   * TUNABLE (chunk 12 QA D1). THE fence-hit rule: one unit takes at most this fraction of a
   * fence segment's MAX HP (×0.50) from it PER TICK, summed over every fence hit it lands that
   * tick — its normal hit (buffed or not, ×SIEGE_FENCE_DAMAGE_MULT or not) and its
   * structure-breaker ability together. So a full segment of every tier needs at least two
   * blows from one unit, whatever the merge level, siege, buff or ability. Without it the
   * worst ability case — a level-5 Buffalo Bull (offense 120, merged hit 292) at ×5 with
   * stone siege added (×5 + ×4 − 1 = ×8) — deals 2336 to a 1000-HP Stacked Stone segment, and
   * its normal siege hit alone (×4) deals 1168.
   */
  FENCE_HIT_SEGMENT_CAP: fpMilli(500),

  // ────────────────────────────────────────────────────────────────────────────────────
  // Traps / siege / fences (chunks 07 and 11 consume)
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE. Flat, single-trigger trap damage spread; a test asserts every trap is inside it. */
  TRAP_DAMAGE_MIN: 90,
  TRAP_DAMAGE_MAX: 375,
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
  // Chunk 07 — the wagon circle's placement lattice and material budget. Consumed by
  // @caravan/circle; the resolver (chunk 10) reads the same values through it.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (chunk 07). Placement lattice size in cells. Driven by fight length vs. screen size. */
  GRID_WIDTH: 32,
  GRID_HEIGHT: 32,
  /**
   * TUNABLE (chunk 07). Chebyshev radius of the fence ring around the core centre, in cells.
   * The ring is the square of cells at exactly this radius: 8 × radius cells, of which the
   * RING_ANCHOR_CELLS corners are fixed wagon anchors and the rest are fence positions, so
   * PERIMETER_SEGMENTS below must equal 8 × radius − RING_ANCHOR_CELLS and a test asserts it.
   *
   * The geometry itself (ring cells, anchors, core, entry bands) is OWNED by
   * @caravan/resolver (battlefield.ts) because a stored replay depends on it; these registry
   * values mirror it for the UI and the circle model, and @caravan/circle asserts at import
   * that the two agree.
   */
  PERIMETER_RING_RADIUS: 4,
  /**
   * Fixed by design (chunk 07 QA D2): the ring's four corner cells are permanent, impassable
   * wagon anchors — shown as parked wagons, never buyable fence, never a gap. The Battlefield
   * input carries them as blocked cells. A square ring has exactly four corners.
   */
  RING_ANCHOR_CELLS: 4,
  /** TUNABLE (chunk 07). Fence positions on the ring (8 × radius − RING_ANCHOR_CELLS), each independently placed or left as a gap. */
  PERIMETER_SEGMENTS: 28,
  /**
   * TUNABLE (chunk 07). Fence segments a caravan can pack for a trip. THE most important
   * balance lever in chunk 07: it is deliberately BELOW PERIMETER_SEGMENTS so a full ring is
   * unaffordable and choosing where the gap goes is a real decision (20 of 28 still forces 8
   * gaps). A test asserts FENCE_MATERIAL_BUDGET < PERIMETER_SEGMENTS; raising it to the ring
   * size deletes the game.
   */
  FENCE_MATERIAL_BUDGET: 24,
  /**
   * Fixed by design (chunk 07 QA D2, decided for chunk 10): lattice pathing is 4-connected —
   * orthogonal steps only, no diagonal moves and therefore no corner cutting between two
   * diagonally-touching blocked cells. The circle's reachability check and the resolver's
   * pathfinder must both read this; a full ring of fence plus the four anchors seals the core
   * only because diagonals are not steps.
   */
  PATH_CONNECTIVITY: 4,
  /** Fixed by design in MVP (chunk 07): the caravan core is a CORE_SIZE × CORE_SIZE block at the lattice centre, not player-placed. */
  CORE_SIZE: 3,
  /** TUNABLE (chunk 07). Minimum Euclidean distance between two unit posts, in cells. 1.0 = distinct cells. */
  MIN_POST_DISTANCE: fp(1),
  /** TUNABLE (chunk 07 / chunk 09 START_POSITION_BAND). Attackers start in the outermost N cells of their chosen edge. */
  ENTRY_BAND_DEPTH: 2,

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 10 — the resolver's tick loop and movement. The resolver never reads this
  // registry: @caravan/circle's resolverTunables() hands these to it as plain input.
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * TUNABLE (chunk 10) — but FIXED FOREVER once golden logs exist: changing it invalidates
   * every stored replay. Ticks per second. 20 is fine enough for smooth playback, coarse
   * enough to keep logs small. Must divide 1000 so content's millisecond durations convert
   * to whole ticks without drift.
   */
  TICK_RATE: 20,
  /** TUNABLE (chunk 10). Stalemate threshold, in seconds because that is what a player experiences. TICK_CAP = this × TICK_RATE (3,600), derived, never authored. */
  BATTLE_LENGTH_CAP_SECONDS: 180,
  /**
   * TUNABLE (chunk 10). Paths are recomputed every 500 ms (= 10 ticks at TICK_RATE 20) — a
   * fixed interval, never event-timing-dependent — and immediately on target change or a
   * fence break. In milliseconds like every duration here; the resolver converts to ticks.
   */
  PATH_RECOMPUTE_INTERVAL: ms(500),
  // PATH_CONNECTIVITY (4) lives in the chunk 07 block above; the resolver accepts only 4.
  /** TUNABLE (chunk 10). 0.35 cells. Used for attack-range and ability-radius checks (chunks 11–12), never for collision — units overlap freely. */
  UNIT_RADIUS: fpMilli(350),
  /** TUNABLE (chunk 13, consumed from chunk 10). A full-state keyframe every 5 s (= 100 ticks) so playback can seek and truncation is detectable. */
  LOG_KEYFRAME_INTERVAL: seconds(5),

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 13 — outcomes, depth-scaled loot and the replay. The resolver reports the end
  // condition and DEPTH; it never sees Coin. The server turns depth into the party OWNER's
  // loot (apps/server/src/trip/loot.ts) and stores the log (encounter_log).
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Fixed by design (chunk 13; the resolver implements it — packages/resolver/src/outcome.ts).
   * "How far the deepest raider got inside the wagon circle: the share of the distance from the
   * ring's outer edge to the core that it closed." Measured from the ring line since resolver v8
   * (QA-13 D1; it was from the spawn edge and saturated), 0 for a raider that never crossed it.
   * An integer 0..1024 (1024 = the core; only an overrun reaches it). Fence segments broken and
   * posts killed are NOT added in (a composite cannot be previewed in one sentence).
   */
  DEPTH_METRIC: "deepest_raider_share_of_ring_to_core_distance",
  /**
   * Fixed shape (chunk 13). The party owner's loot when the party is WIPED (the caravan held):
   * full × depth^1.5, computed integer-only as floor(full × d × isqrt(d × 1024) / 1024²) with
   * d = depth (0..1024) — sub-linear, so a near miss is worth meaningfully less than a clear but
   * not nothing, and never more than full. STALEMATE_LOOT_SHARE below is the tunable end; `full` is the encounter's Coin value at the
   * caravan's band from the chosen menu row (chunk 16 coinForEncounter(n, band)), stamped at enqueue.
   */
  PARTIAL_LOOT_CURVE: "full_x_depth_pow_1_5",
  // FULL_CLEAR_LOOT (chunk 13's table) has no knob of its own (chunk 15 QA S4): on an overrun the
  // owner is paid chunk 19's transfer of the trip's unbanked Coin plus COIN_PER_PARTY_WIN, both
  // capped by their headroom — the depth-scaled loot is 0 there, so a clear is never paid twice.
  /** TUNABLE (chunk 13). STALEMATE_LOOT, fixed-point share: 0 — a party that cannot win cannot stall for value (the safety valve favours the caravan). */
  STALEMATE_LOOT_SHARE: fp(0),
  /** TUNABLE (chunk 13). LOG_SIZE_BUDGET: a stored (gzip-compressed) replay above this is a format problem, not a storage bill. Measured in the resolver's budget test. */
  LOG_SIZE_BUDGET_BYTES: 100 * 1024,
  /** TUNABLE (chunk 13). LOG_RETENTION: a stored replay is kept this long … */
  LOG_RETENTION_DAYS: 30,
  /** TUNABLE (chunk 13). … or while it is among the caravan's newest this-many encounters, whichever keeps it longer. */
  LOG_RETENTION_MIN_PER_CARAVAN: 50,
  // Chunk 09 — the standing raid party (the PASSIVE side; GUARDRAILS §0). A template,
  // never consumed, never loses units. Nothing here is purchasable: Coin cannot buy a
  // bigger party, more siege slots or extra parties (GUARDRAILS §2).
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * TUNABLE (chunk 09). Living units a standing party fields. Matched to DEPLOYMENT_SLOT_CAP
   * so the two sides are comparably sized. A merged unit takes ONE slot whatever its level —
   * slot efficiency is the entire benefit of merging (GUARDRAILS §2). A test asserts equality.
   */
  PARTY_SLOT_CAP: 8,
  /** TUNABLE (chunk 09). Siege pieces a party carries, separate from unit slots. Each is a distinct counter bet. */
  SIEGE_SLOT_CAP: 3,
  /** Fixed by design (chunk 09). A party may split across every entry edge: all four. Must equal ENTRY_EDGES.length. */
  MAX_APPROACH_EDGES: 4,
  /**
   * Fixed by design (chunk 09, PARTY_EDIT_COOLDOWN). Editing the party is free and instant.
   * 0 means NO cooldown; a non-zero value would create a Coin sink that sells convenience,
   * so nothing reads this as anything but a documented zero. A test asserts it is 0.
   */
  PARTY_EDIT_COOLDOWN_MS: 0,
  /**
   * TUNABLE (chunk 09). Standing parties per account in v1. The schema allows more
   * (standing_party is keyed by its own id with a per-account slot; PHASE-2 §43 raises this);
   * the service refuses a slot ≥ this value.
   */
  PARTIES_PER_ACCOUNT: 1,

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 14 — matchmaking & scouting. Picks WHO ATTACKS THE CARAVAN (GUARDRAILS §0):
  // standing parties, banded by Reputation. Randomness here shapes only which candidates
  // are OFFERED, seeded from stored state (§1). The reroll is free and time-gated; there
  // is no Coin path in this block or anywhere on the search path (§2). Every candidate is
  // scouted in full before the player commits (§4). Whole integers throughout.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** Fixed by design (chunk 14). A search offers exactly this many candidates; the player picks one. */
  CANDIDATES_PER_SEARCH: 3,
  /**
   * TUNABLE (chunk 14). Half-width of the Reputation band around the (escalated) centre on
   * the first pass: candidates whose owner's siege Reputation is within ±this. The band
   * SPAN (2 × width) is also the size of a display band (band k = [FLOOR + k·span, …)).
   */
  REPUTATION_BAND_WIDTH: 150,
  /** TUNABLE (chunk 14). Each failed pass (fewer than CANDIDATES_PER_SEARCH eligible) widens the half-width by this. */
  REPUTATION_BAND_WIDEN_STEP: 100,
  /** TUNABLE (chunk 14). The widest half-width a search will use before the authored fallback. */
  REPUTATION_BAND_WIDTH_MAX: 600,
  /**
   * TUNABLE (chunk 14). Searching again for the same encounter is FREE and gated only by
   * this many seconds since the last search. NEVER purchasable: no Coin, no pack and no
   * "skip the wait" surface may read or shorten this (GUARDRAILS §2). A test greps for it.
   */
  REROLL_COOLDOWN_SECONDS: 180,
  /** Fixed by design (chunk 14). A caravan never meets its own account's party. Linked accounts (PHASE-2 §31) are excluded the same way. */
  SELF_EXCLUDE: true,
  /** TUNABLE (chunk 14). The last N parties this ACCOUNT committed to (any caravan, any trip) are not offered again. Enforced server-side. */
  RECENT_OPPONENT_EXCLUSION: 5,
  /**
   * TUNABLE (chunk 14). Difficulty escalation: the band centre rises by this many basis
   * points of the band SPAN (2 × REPUTATION_BAND_WIDTH) per encounter index beyond the
   * first. 500 bp of 300 = +15 Reputation per encounter. Central to bank-or-push: pushing
   * must mean a harder party, legibly. Tune with care.
   */
  DIFFICULTY_ESCALATION_BP: 500,
  /**
   * TUNABLE (chunk 19 QA D2b). Encounter 1 of a trip is matched BELOW the caravan's living
   * Reputation: its band centre is rating + this (−150, a half display band). Encounters 2+
   * use the unchanged escalation (rating + 15·(n − 1)); the offset applies to encounter 1
   * only. So the first fight of a trip is the one a circle at its equilibrium rating most
   * often holds — a trip with merged units in it is worth starting. The sandbagging floor
   * measures the gap beyond the band ACTUALLY searched (centre − width), so this offset can
   * never floor a party it served (matchmaking/band.ts `sandbagGap`). Non-positive integer.
   */
  FIRST_ENCOUNTER_CENTRE_OFFSET: -150,
  /**
   * Fixed by design (chunk 14). When a band holds too few candidates: widen (above), then
   * fill from AUTHORED parties (system-owned, the same object as any other party, never
   * special-cased downstream). Never a fabricated party, never a resolver special case.
   */
  EMPTY_POOL_BEHAVIOR: "widen_then_authored",
  /**
   * Fixed by design (chunk 14). The candidate draw is seeded by FNV-1a (32-bit) over
   * `<caravan id>:<trip id>:<encounter index>:<search sequence>` and drawn with xorshift32
   * — integer-only, stored with the menu, so any menu ever offered can be replayed.
   */
  CANDIDATE_SELECTION_SEED: "fnv1a32(caravanId:tripId:encounterIndex:searchSeq)",
  /**
   * TUNABLE (chunk 14 / PHASE-2 §25). Authored parties retire BY RATIO: in a band holding L
   * live parties, at most floor(L × share / (1 − share)) authored parties join the draw
   * (so authored ≤ share of the pool), except that enough always join to reach
   * CANDIDATES_PER_SEARCH. Basis points.
   */
  AUTHORED_PARTY_MAX_SHARE_BP: 3000,
  /**
   * TUNABLE (chunk 14 / PHASE-2 §31, chunk 04 QA D2). Sandbagging floor on Coin EARNED per
   * encounter: when the caravan's living Reputation exceeds the party owner's siege
   * Reputation by more than SANDBAG_EARN_GAP_START, the encounter's Coin earn is scaled by
   * 1 − (gap − start) / REPUTATION_GAP_DIVISOR, floored at SANDBAG_EARN_MULT_MIN. Shown on
   * every candidate before the player commits; chunk 19 applies it. Identical for every
   * account; it reads ratings only.
   */
  SANDBAG_EARN_GAP_START: 300,
  SANDBAG_EARN_MULT_MIN: fpMilli(250),

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 25 — authored cold-start parties (PHASE-2 §25). System-owned standing parties,
  // the SAME object as any player's, so the pool is never empty. These numbers shape only
  // how many exist and how often they are served; nothing here reaches the resolver.
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * TUNABLE (chunk 25). The highest Reputation the authored set covers: parties exist for
   * every display band from the one holding REPUTATION_FLOOR to the one holding this. The
   * expected ceiling of play; raise it (and the set regenerates) if players climb past it.
   */
  AUTHORED_REPUTATION_CEILING: 2200,
  /** TUNABLE (chunk 25). Authored parties per display band. PHASE-2 §25 asks for at least 12. */
  AUTHORED_PARTIES_PER_BAND: 12,
  /**
   * TUNABLE (chunk 37 balance pass, BALANCE-LOG.md). The authored difficulty curve's party size:
   * AUTHORED_PARTY_SIZE_FLOOR raiders in the floor band, rising by AUTHORED_PARTY_SIZE_RISE over the
   * set (capped at PARTY_SLOT_CAP), and party leaders one merge level up only from band ordinal
   * AUTHORED_LEADER_FROM_BAND_ORDINAL — so the bands a fresh caravan meets first are unmerged
   * three-raider starter outfits and difficulty rises monotonically from there.
   */
  AUTHORED_PARTY_SIZE_FLOOR: 3,
  AUTHORED_PARTY_SIZE_RISE: 7,
  AUTHORED_LEADER_FROM_BAND_ORDINAL: 2,
  /**
   * TUNABLE (chunk 25). Retire-by-ratio, second stage: the most recent N SERVED encounters
   * (chosen candidates in encounter_candidates) whose band centre fell in a display band
   * are the rolling window over which that band's authored served share is measured
   * against AUTHORED_PARTY_MAX_SHARE_BP. Counted from stored rows: deterministic, replayable.
   */
  AUTHORED_SERVED_SHARE_WINDOW: 40,
  /**
   * TUNABLE (chunk 25). When a band's authored served share is over the cap, the by-ratio
   * authored allowance of a draw in that band is scaled by this many basis points (so 2500
   * = a quarter of the usual allowance, floored) — never below what it takes to fill the
   * menu at the widest pass. Releases by itself as live parties are served.
   */
  AUTHORED_OVER_SHARE_WEIGHT_BP: 2500,
  /**
   * TUNABLE (chunk 25 QA D1/D2). Cold-start fairness: when authored parties FILL a menu (the
   * widest pass, and the outside-band fallback), they are drawn seeded from the N nearest
   * the band centre (ties by party id), never from the whole widest band — so a fresh
   * player at 1000 meets parties about a band away at most, and rerolls above the authored
   * ceiling still vary. Stored with each menu (encounter_candidates.draw_rules) so a change
   * never alters a replay.
   */
  AUTHORED_FILL_NEAREST_N: 6,

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 16 — Coin economy and merge pricing. Coin buys PACE only (GUARDRAILS §2): nothing
  // here reaches a stat, a resolution rule, or the merge cap. Plain integer Coin amounts.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (chunk 16). Coin for surviving the FIRST encounter of a trip. Later encounters escalate (below). */
  COIN_PER_ENCOUNTER_BASE: 400,
  /**
   * TUNABLE (chunk 16; ×1.25 → ×1.35 by chunk 15 QA D1). ×1.35 per subsequent encounter
   * (1382/1024 ≈ 1.3496 in fixed point), compounding, floored each step — 400, 539, 727,
   * 981, 1323, … Steeper than before so that pushing past encounter 1 is a real decision
   * (break-even hold rate ≈ 0.44 with the per-encounter delivery below).
   */
  COIN_ENCOUNTER_ESCALATION_MULT: fpMilli(1350),
  /**
   * TUNABLE (chunk 19 QA D2a). Encounter Coin scales with the caravan's living-Reputation
   * DISPLAY band (matchmaking's bandOf: band k = [FLOOR + k·300, …), REPUTATION_START 1000 is
   * band 3): coinForEncounter(n, band) = schedule(n) × (10 000 + band × this) / 10 000,
   * floored, clamped at COIN_STORAGE_CAP. 5000 bp = +50% of the base per band, so band 3 pays
   * ×2.5. Higher-rated circles (merged units) fight harder parties and must earn more for a
   * trip to be worth its rebuild risk. The band is the caravan rating stored on the encounter's
   * chosen menu row (what the player saw), and the result is stored per encounter at accrual
   * (trip_encounter.coin_accrued), so a later rating move or retune never changes it. The
   * delivery (below) does not scale. Numbers are a first cut; chunk 32/§37 tune them against
   * resolver-measured hold rates (scripts/balance/trip-ev.ts).
   */
  COIN_ENCOUNTER_BAND_SCALE_BP: 5000,
  /**
   * TUNABLE (chunk 15 QA D1; replaces chunk 16's flat 500 COIN_PER_BANKED_TRIP). The delivery
   * reward on a banked trip: this × encounters survived, no flat bonus — a flat bonus made
   * banking after encounter 1 dominate at the equilibrium hold rate.
   */
  COIN_DELIVERY_PER_ENCOUNTER: 125,
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
   * TUNABLE (chunk 16, QA S4). The trickle is DISPLAYED to the player on every read but only
   * MATERIALIZED as a ledger event once at least this many whole coins have accrued, or
   * (below) once this much time has passed since the accrual point — whichever comes first.
   * Keeps a player polling the balance from writing one ledger row per 18 s. Neither
   * threshold changes what is earned: the pending coins are carried, never dropped.
   */
  TRICKLE_MATERIALIZE_MIN_COINS: 10,
  /** TUNABLE (chunk 16, QA S4). See TRICKLE_MATERIALIZE_MIN_COINS. 15 minutes. */
  TRICKLE_MATERIALIZE_MIN_MS: 15 * 60_000,
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
  // Chunk 15 — the trip loop. A trip is a chain of matchmade encounters, nothing more: no
  // geography, no travel timer. The cap is per ACCOUNT, consumed at trip START (never per
  // encounter), regenerates lazily from a stored timestamp, and is never purchasable — no
  // Coin, pack or entitlement can refill or raise it (GUARDRAILS §2).
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (chunk 15). Trip starts stored at most; one is consumed per trip however many encounters it has. */
  TRIPS_PER_HOUR_CAP: 3,
  /** TUNABLE (chunk 15). One trip-cap use regenerates every 20 minutes (3 per hour at the cap of 3). */
  TRIP_CAP_REGEN_MS: 20 * 60_000,
  /**
   * Fixed by design (chunk 15). No repair, resupply or healing between encounters: unit HP,
   * fence HP and spent traps carry forward. Not tunable; documented so nobody adds a knob.
   * MAX_ENCOUNTERS_PER_TRIP is deliberately absent (unbounded): attrition plus chunk 14's
   * escalation is the limit. Add a cap only if testing shows a degenerate infinite push.
   */
  NO_REPAIR_BETWEEN_ENCOUNTERS: true,
  /**
   * Fixed by design (chunk 15). A banked caravan refits fully in town (every packed unit at
   * full HP, traps restocked, fences rebuilt — the next manifest is packed fresh); an
   * overrun caravan has nothing to restore (chunk 19 applies its losses).
   */
  RESTORE_ON_TRIP_END: "full_on_bank_none_on_overrun",

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 19 — stakes and loss. Harsh but BOUNDED (GUARDRAILS "Bounded stakes"): a trip
  // risks only its own unbanked Coin and what was packed for it. The INVERSION is the
  // design: a unit that DIES on a trip is de-merged (one level, floored); a unit still
  // ALIVE when the caravan falls is destroyed. The standing party's owner risks nothing.
  // ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Fixed by design (chunk 19). Merge levels a unit loses for dying in an encounter, applied
   * once when the trip ends (bank OR overrun), whatever killed it. Floored at
   * MERGE_LEVEL_MIN (DEMERGE_FLOOR), so de-merging alone can never erase a unit.
   */
  DEMERGE_LEVELS_PER_DEATH: 1,
  /**
   * Fixed by design (chunk 19). Share of a trip's unbanked Coin lost on an overrun, in basis
   * points: all of it (all-or-nothing). Transferred to the overrunning party's owner, capped
   * by their storage headroom; the excess (or all of it, for a system owner) is destroyed.
   */
  UNBANKED_COIN_LOST_ON_OVERRUN_BP: 10_000,

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 20 — monetization packs (GUARDRAILS §2). Nothing in this block reaches a stat, a
  // resolution rule, a cap, an unlock, a slot count or a trip-cap use: a pack holds COIN
  // (pace) and COSMETICS (purely visual), and the schema's CHECK on pack contents mirrors
  // PACK_CONTENT_KINDS so nothing else can be put in one. The resolver cannot import this
  // registry at all (scripts/resolver-boundary-check.mjs), so none of these numbers is even
  // visible from inside a resolution.
  //
  // ── THE P2W-RELEVANT NUMBER IS WEEKLY_PAY_CEILING (60,000), NOT ANY SINGLE TIER ──
  // All three tiers stack in the same week, each once. Anyone sizing the pay-to-accelerate
  // ceiling against free play must use the combined sum. The assumed ratio is recorded
  // below so a balancer can re-check it when either side moves.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** Fixed by design (chunk 20). Three tiers, in whole US cents: $5 / $10 / $25. Index = tier − 1. Never a float. */
  PACK_TIER_PRICES_CENTS: [500, 1_000, 2_500],
  /**
   * TUNABLE (chunk 20), but FIXED WEEK TO WEEK and player to player: the Coin in each tier.
   * Index = tier − 1. Mild upward value scaling by tier is intended (1,200 / 1,400 / 1,600
   * Coin per dollar); the amounts never vary by week, by player, or by anything else — a
   * test asserts every week of a long horizon returns these exact numbers.
   */
  PACK_COIN_BY_TIER: [6_000, 14_000, 40_000],
  /**
   * TUNABLE (chunk 20) — THE pay-to-win guardrail number. The most Coin money can add to an
   * account in one week: all three tiers combined (6,000 + 14,000 + 40,000). Validated on
   * load to equal the sum of PACK_COIN_BY_TIER; change the tiers and this moves with them.
   * Note it exceeds COIN_STORAGE_CAP (50,000): a player who buys everything at once cannot
   * hold it all, which is why the store shows the overflow forecast before purchase.
   */
  WEEKLY_PAY_CEILING: 60_000,
  /**
   * ASSUMPTION TO VALIDATE IN PLAYTESTING (chunk 20; re-derived by chunk 19 QA D3 from
   * realistic hold rates, after chunk 15 QA D1's schedule and chunk 19 QA D2's band scaling).
   * A normal active week's free Coin is a RANGE, not one number. The derivation is
   * `scripts/balance/trip-ev.ts` (model.ts `weeklyFreeEarn`): the full-week trickle
   * (200/h × 168 h = 33,600) plus N trips, each worth its gross Coin banked at the best-EV
   * point for an 8 × L1 circle (the cheapest to lose, so the most pushed), at display band 3
   * (REPUTATION_START), hold rate p1 − 0.05 per encounter after the first:
   *   - LOW  — 3 trips/h for ~5 h (15 trips), p1 0.60: 33,600 + 15 × 675 ≈ 43,700.
   *   - MID  — 5 × 1 h sessions opening with the regen burst (30 trips), p1 0.65:
   *            33,600 + 30 × 731 ≈ 55,500.
   *   - HIGH — 7 × 1 h sessions (42 trips), p1 0.70: 33,600 + 42 × 788 ≈ 66,700.
   * (At those hold rates an L1 circle banks after encounter 1; the chunk 15 shapes — 39k /
   * 94k / 118k — assumed every trip ran 3 encounters at the old schedule.) This constant is
   * the MID value rounded down to the thousand, and the 1.5× bound below is checked against
   * it (QA-19 D3): the ceiling is 60,000 / 55,000 ≈ 1.09× the mid week, 1.37× the low, 0.90×
   * the high. The storage cap (COIN_STORAGE_CAP 50,000) also bounds the effective paid add
   * to cap − balance per spend cycle, and the once-per-tier-per-week limit means the ceiling
   * cannot be reached twice in a week. Hold rates are guesses until chunk 13's resolver
   * measures them: re-run the script with measured rates (PHASE-2 §37) and re-derive when
   * COIN_PER_ENCOUNTER_BASE, COIN_ENCOUNTER_BAND_SCALE_BP, COIN_DELIVERY_PER_ENCOUNTER, the
   * trip cap, the trickle, or chunk 15's tunables move. The party-win income (passive) is not
   * counted: it depends on other players.
   */
  FREE_WEEKLY_EARN_ESTIMATE: 55_000,
  /**
   * TUNABLE (chunk 20). The target bound on WEEKLY_PAY_CEILING / FREE_WEEKLY_EARN_ESTIMATE in
   * basis points: paying should not exceed ~1.5× an active free player's week (the derived
   * MID week, chunk 19 QA D3). At the defaults the ratio is ≈ 1.09× (60,000 / 55,000); it
   * was exactly 1.5× against the old 40,000 floor shape. Validated on load as
   * WEEKLY_PAY_CEILING × 10,000 ≤ FREE_WEEKLY_EARN_ESTIMATE × this.
   */
  PAID_TO_FREE_RATIO_MAX_BP: 15_000,
  /** TUNABLE (chunk 20). Rotation period of the COSMETICS in packs, 7 days. Coin amounts do not rotate. */
  PACK_ROTATION_PERIOD_MS: 7 * 24 * 60 * 60_000,
  /**
   * Fixed by design (chunk 20). The instant week 0 of the rotation began: 2026-01-05T00:00:00Z
   * (a Monday). Week index = floor((now − epoch) / PACK_ROTATION_PERIOD_MS). Identical for
   * every player; the only thing the wall clock decides is WHICH week it is, never what a
   * week contains. Changing this re-numbers every stored purchase's week; do not.
   */
  PACK_ROTATION_EPOCH_MS: 1_767_571_200_000,
  /** TUNABLE (chunk 20 / PHASE-2 §28). How many weeks ahead the store previews the rotation. */
  PACK_ROTATION_PREVIEW_WEEKS: 1,
  /** TUNABLE (chunk 20). Cosmetics per tier each week (index = tier − 1). Six distinct per week; the catalog must hold at least that many. */
  PACK_COSMETICS_BY_TIER: [1, 2, 3],
  /**
   * Fixed by design for MVP (chunk 20). The purchase backend records the grant and charges
   * NOTHING. Real payment integration is PHASE-2 §34; the server refuses to start a purchase
   * under any other backend name, so a real one has to be wired in deliberately.
   */
  PURCHASE_BACKEND: "sandbox_stub",
  /** Fixed by design (chunk 20). Each tier once per week; tiers stack across each other, never within. A unique index enforces it. */
  PURCHASE_LIMIT_PER_TIER_PER_WEEK: 1,
  /**
   * Fixed by design (chunk 20, GUARDRAILS §2/§3). THE ONLY things a pack may contain. Not
   * unlock points, not unit access, not trip-cap uses, not slot count, not fence material,
   * not repairs, not resupply, not matchmaking rerolls. Mirrored by a CHECK constraint on
   * pack_purchase.contents (migration 010) and asserted by a content test.
   */
  PACK_CONTENT_KINDS: ["coin", "cosmetic"],

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 18 — unit acquisition: refugee drip and mercenary recruit (GUARDRAILS §3).
  // Both paths grant LEVEL-1 instances of types the caravan has ALREADY reached in its
  // living web; nothing here can widen that pool. Coin buys pace and certainty only.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (chunk 18). The free refugee timer: a fresh menu of offers every 90 minutes. */
  REFUGEE_REFRESH_INTERVAL_MINUTES: 90,
  /** Fixed by design (chunk 18). A refugee menu offers exactly this many types; the player takes exactly one. */
  REFUGEE_OFFER_COUNT: 3,
  /**
   * TUNABLE (chunk 18). Coin cost of the Nth reroll within one free-refresh window
   * (index 0 = first reroll). Past the end of the table the LAST value repeats. The window
   * — and so the index — resets on every free refresh. A reroll buys a SOONER menu from
   * the SAME unlocked pool, never a wider or better one.
   */
  REFUGEE_REROLL_COST_SCHEDULE: [150, 300, 600],
  /**
   * Fixed by design (chunk 18). Offers are drawn uniformly, without replacement, from the
   * caravan's unlocked living pool sorted by type id; when the pool holds fewer types than
   * REFUGEE_OFFER_COUNT the remaining slots are drawn uniformly WITH replacement from the
   * same pool, so a menu is always exactly REFUGEE_OFFER_COUNT offers. No type is ever
   * weighted up, down, or excluded while it is unlocked.
   */
  REFUGEE_OFFER_WEIGHTING: "uniform_without_replacement",
  /**
   * Fixed by design (chunk 18). The menu seed is derived from (caravan id, refresh sequence
   * number) by FNV-1a (32-bit) over `<caravan id>:<sequence>`, then drawn with xorshift32 —
   * integer-only and stored with the menu so QA can replay any menu ever offered.
   */
  REFUGEE_OFFER_SEED: "fnv1a32(caravanId:sequence)",
  /**
   * TUNABLE (chunk 18). Coin for one guaranteed level-1 copy of any unlocked type. ALWAYS
   * available for every unlocked type: no cooldown, no daily limit, no per-type restriction —
   * this is the safety valve that makes the refugee drip's randomness acceptable.
   */
  MERCENARY_COST_BASE: 600,
  /** Fixed in MVP (chunk 18). No scaling of the mercenary cost; if any is ever added it must never make a type unobtainable. */
  MERCENARY_COST_SCALING: "none",
  /**
   * TUNABLE (chunk 18). Storage guard on unit instances per caravan — generous on purpose
   * (a full 8-slot level-5 circle needs 128 level-1 copies in total, far fewer at once) so
   * it never blocks acquisition in practice. Not a balance lever.
   */
  UNIT_INVENTORY_CAP: 200,

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 17 — the home town's merge board. Presentation-side limits only: the board is a
  // working surface backed by the overflow inventory (UNIT_INVENTORY_CAP above), so it can
  // never block acquisition (GUARDRAILS §3) and never touches a stat or a resolution rule.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (chunk 17). Visible merge-board slots: BOARD_SIDE × BOARD_SIDE cells of the town's flat centre. Tight enough to push merging, loose enough not to punish. */
  BOARD_SLOTS: 36,
  /** TUNABLE (chunk 17). The board is a BOARD_SIDE × BOARD_SIDE square; BOARD_SLOTS must equal its square (asserted by the client's board model test). */
  BOARD_SIDE: 6,
  /**
   * TUNABLE (chunk 17, MINE_ANIMATION; QA-17 N7). Milliseconds for one full turn of the town
   * mine's head-frame wheel while the store is below the cap. Presentation only: the wheel
   * counts nothing (the balance shown is the server's), it stops at the cap and under
   * reduced motion, and nothing in the resolver or the economy reads it. An integer like
   * every tunable (12 500 ms = 0.08 turns per second).
   */
  MINE_WHEEL_MS_PER_TURN: 12_500,

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
   * a win clamped to [MULT_MIN, MULT_MAX] and a loss to [MULT_MIN_LOSS, MULT_MAX].
   * Beating someone DIVISOR above you doubles the gain; losing to someone DIVISOR below
   * you doubles the loss. Blunts sandbagging (PHASE-2 §31): farming far-weaker parties
   * pays a quarter of the base gain at most.
   *
   * MULT_MIN_LOSS (chunk 04 QA D2): the loss-side floor is deliberately HIGHER than the
   * win-side floor, so tanking a rating on purpose (losing to far stronger opponents) is
   * about twice as slow as the win-side ramp would otherwise make it. Must satisfy
   * |base delta| × MULT_MIN ≥ FIXED_ONE for every base delta, so no scaled delta
   * truncates to zero (asserted at startup in apps/server/src/progression/reputation.ts).
   */
  REPUTATION_GAP_DIVISOR: 400,
  REPUTATION_GAP_MULT_MIN: fpMilli(250),
  REPUTATION_GAP_MULT_MIN_LOSS: fpMilli(500),
  REPUTATION_GAP_MULT_MAX: fp(2),

  // ────────────────────────────────────────────────────────────────────────────────────
  // Chunk 05 — the unlock webs. THE only access gate in the game (GUARDRAILS §3): a type
  // exists for a player iff its node is reached. Funded only by UNLOCK_POINTS_BY_RUNG
  // (30 per pool at ladder cap). Every number here is read by unlockWebs.ts and
  // apps/server/src/unlocks; nothing there is inline.
  // ────────────────────────────────────────────────────────────────────────────────────

  /** TUNABLE (chunk 05). Nodes in each region's living web: one per living-unit type, so must equal LIVING_UNITS_PER_REGION (validated on load). */
  LIVING_WEB_NODES: 8,
  /** TUNABLE (chunk 05). Nodes in the trap web: one per trap type PLUS one per fence tier (fence tiers are unlock-web purchases, PROJECT.md §20) = TRAP_TYPES + FENCE_TIERS (validated). */
  TRAP_WEB_NODES: 10,
  /** TUNABLE (chunk 05). Nodes in the siege web: one per siege type = SIEGE_TYPES (validated). */
  SIEGE_WEB_NODES: 5,
  /** TUNABLE (chunk 05). Deepest paid tier; tiers run 0..UNLOCK_WEB_TIERS, tier 0 being the free starting nodes. */
  UNLOCK_WEB_TIERS: 4,
  /**
   * TUNABLE (chunk 05, NODE_COST_CURVE; chunk 05 QA D1). Unlock points to reach a node,
   * indexed by its tier, PER POOL. Tier 0 = a STARTING node: reached free at creation, cost 0
   * by construction (validated). The first paid tier costs 1 point in every pool so the
   * first unlock is immediate. Sized against UNLOCK_POINTS_BY_RUNG (30 per pool at cap):
   * with the brief's node counts the paid totals are living 39, trap 39, siege 38, so a
   * capped ladder reaches ~77–79% of each web — "most but not all", a choice, not a
   * checklist. Every root-to-node path stays ≤ 30, so every node is reachable at cap
   * (validated on load); which ones is the player's call.
   */
  UNLOCK_NODE_COST_BY_TIER: {
    living: [0, 1, 4, 8, 14],
    trap: [0, 1, 3, 7, 10],
    siege: [0, 1, 8, 15, 21],
  },
  /**
   * TUNABLE (chunk 05, STARTING_NODES). How many tier-0 nodes each web has — reached free at
   * creation so a new account can actually play. 2 living per region, 1 trap, 1 siege (the
   * brief), plus 1 fence tier: the brief lists no starting fence, but a caravan with no fence
   * tier has no circle at all (chunk 07's assumption, confirmed here). The fence starter is
   * a node of the TRAP web (fence tiers live there), counted separately so the data can be
   * checked against it.
   */
  STARTING_NODES: { living: 2, trap: 1, fence: 1, siege: 1 },
  /** TUNABLE (chunk 05, WEB_SHAPE). Roots (nodes with no prerequisite) per web, inclusive bounds: a "web", not a line — multiple viable paths. */
  WEB_ROOTS_MIN: 2,
  WEB_ROOTS_MAX: 3,
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
