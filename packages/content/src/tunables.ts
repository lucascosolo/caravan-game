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
} as const;
