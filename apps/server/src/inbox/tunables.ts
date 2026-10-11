/**
 * Chunk 29 inbox knobs. Like chunk 02's job knobs (src/jobs/tunables.ts), these are NOT
 * balance constants and do not live in the @caravan/content registry: none of them enters a
 * resolution, a price, a reward or anything a player commits a resource against. They decide
 * only how notifications are grouped and how far back the inbox looks. Each is TUNABLE.
 */

/** The categories PHASE-2 §29 names for group A (season / contract events arrive with group B). */
export const INBOX_CATEGORIES = ["party_strike", "refugees_arrived", "trip_cap_refilled", "mine_near_cap", "packs_rotated"] as const;
export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

/**
 * PHASE-2 §29: "per-category opt-out, defaulting on for party strikes and off for everything
 * else." The spec's own rule, kept here beside the list (migration 017 mirrors the names).
 */
export const INBOX_CATEGORY_DEFAULTS: Readonly<Record<InboxCategory, boolean>> = {
  party_strike: true,
  refugees_arrived: false,
  trip_cap_refilled: false,
  mine_near_cap: false,
  packs_rotated: false,
};

/**
 * TUNABLE. Strikes are batched into fixed windows of this length (aligned to the epoch, so to
 * the UTC hour): "a party that strikes ten times in an hour sends one notification with a
 * count, not ten".
 */
export const INBOX_STRIKE_BATCH_WINDOW_MS = 3_600_000;

/** TUNABLE. How far back the inbox looks. The party results feed (chunk 09) keeps the whole record. */
export const INBOX_HORIZON_MS = 14 * 86_400_000;

/** TUNABLE. Most strike batches listed (newest first). */
export const INBOX_MAX_STRIKE_ITEMS = 30;

/** TUNABLE. Strikes itemized inside one batch (each with its own replay link); the rest are counted, not listed. */
export const INBOX_STRIKES_PER_ITEM = 10;

/**
 * TUNABLE. "Mine near cap": the balance (with pending trickle) is at or above this percent of
 * the storage cap. The trickle stops at the cap (chunk 16), so this is the "about to stop" line.
 */
export const INBOX_MINE_NEAR_CAP_PERCENT = 90;

/** TUNABLE. Most read marks one request may set (a mark-all sends every visible item). */
export const INBOX_MAX_MARKS_PER_REQUEST = 100;
