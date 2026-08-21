/**
 * Every balance constant chunk 09 depends on, in one place, per AGENTS.md's
 * "All balance constants live in the tunables registry" rule. Defaults are
 * taken directly from roadmap/chunks/09-standing-raid-party.md; nothing here
 * is invented. Each is marked tunable — none is fixed by design except where
 * noted.
 */
export const TUNABLES = {
  /** Living units the standing party can hold. Matched to DEPLOYMENT_SLOT_CAP
   * so the active and passive sides are comparably sized. Tunable. */
  PARTY_SLOT_CAP: 8,
  /** Siege slots, separate pool from living units. Tunable. */
  SIEGE_SLOT_CAP: 3,
  /** Fixed by design — exactly these three stances, no more. */
  STANCE_COUNT: 3,
  /** All four sides may be used; splitting across all of them is legal. Tunable. */
  MAX_APPROACH_EDGES: 4,
  /** Outermost N cells of the chosen edge that a starting position may snap to. Tunable. */
  START_POSITION_BAND: 2,
  /** No cooldown on editing a standing party — gating it would just be a Coin
   * sink selling convenience. Fixed by design per the chunk file's rationale. */
  PARTY_EDIT_COOLDOWN_MS: 0,
  /** MVP allows exactly one standing party per account; schema/model must not
   * assume this permanently (see PARTIES_PER_ACCOUNT note in the chunk file). */
  PARTIES_PER_ACCOUNT: 1,
  /** Placement lattice size, shared with chunk 07. Tunable. */
  GRID_WIDTH: 32,
  GRID_HEIGHT: 32,
  /** Minimum interactive touch target, web-first/mobile-shaped. Tunable. */
  TOUCH_TARGET_MIN_PX: 44,

  // --- Economy: Coin (chunk 16) -----------------------------------------
  /** Per-account hard ceiling on Coin accumulation. Tunable. */
  COIN_STORAGE_CAP: 50_000,
  /** Coin for surviving encounter #1 of a trip. Tunable. */
  COIN_PER_ENCOUNTER_BASE: 400,
  /** Fixed-point, scaled by 1000: ×1.25 reward growth per subsequent
   * encounter in the same trip. Tunable. */
  COIN_PER_ENCOUNTER_MULT_MILLI: 1250,
  /** Flat completion bonus for banking a trip. Tunable. */
  COIN_PER_BANKED_TRIP: 500,
  /** Coin awarded to a standing party's owner when it overruns a caravan.
   * Deliberately below the active-play path. Tunable. */
  COIN_PER_PARTY_WIN: 300,
  /** Passive trickle rate, computed lazily from elapsed time on read — never
   * a background tick. Tunable, but must evenly divide 3,600,000ms so the
   * lazy accumulator stays exactly read-frequency-independent (ECON-02);
   * see domain/coin.ts. */
  COIN_TRICKLE_RATE_PER_HOUR: 200,
  /** Coin cost to recruit an exact unlocked type, guaranteed (chunk 18,
   * not built by this chunk). Tunable. */
  MERCENARY_RECRUIT_COST: 600,

  // --- Merge system (chunk 16) -------------------------------------------
  /** Fixed by design — no unit type may merge past level 5, for anyone. */
  MERGE_LEVEL_CAP: 5,
  /** Fixed-point, scaled by 1000: ×1.8 stat growth per merge level. Must
   * stay strictly below 2000 (×2.0) — GUARDRAILS.md #2: a merged unit must
   * never be stronger than its unmerged components combined. Applies to
   * ability values too (chunk 12), once those exist. */
  MERGE_STAT_MULT_PER_LEVEL_MILLI: 1800,
  /** Coin cost of one resulting unit at the given target level, by recipe.
   * Steeply escalating — this is the primary power-pacing lever. */
  MERGE_COST_BY_TARGET_LEVEL: { 2: 250, 3: 900, 4: 3_000, 5: 9_500 },
  /** 2 components -> 1 unit of the next tier. 2.0 units spent per level. */
  MERGE_RECIPE_SMALL: { consumeCount: 2, produceCount: 1 },
  /** 5 components -> 3 units of the next tier. 1.67 units spent per level —
   * a better per-unit rate that rewards patient hoarding. */
  MERGE_RECIPE_LARGE: { consumeCount: 5, produceCount: 3 },
  /** A merged unit occupies exactly this many deployment/board slots, at any
   * level — the entire benefit of merging is slot efficiency, never power. */
  MERGE_SLOT_COST: 1,

  // --- Packing / caravan manifest (chunk 17) ------------------------------
  /** Living units a caravan may carry on a trip. Tunable. */
  DEPLOYMENT_SLOT_CAP: 8,
  /** Traps a caravan may carry on a trip. Tunable. */
  TRAP_SLOT_CAP: 6,
  /** Fence-material segments a caravan may pack, out of FENCE_MATERIAL_CAP. Tunable. */
  FENCE_MATERIAL_BUDGET: 24,
  /** Absolute ceiling on fence-material segments (chunk 07's wagon circle). Tunable. */
  FENCE_MATERIAL_CAP: 32,
  /** Home town merge board size (6×6). Tunable. */
  BOARD_SLOTS: 36,
} as const;
