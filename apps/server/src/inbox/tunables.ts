/**
 * Chunk 29 inbox knobs. Like chunk 02's job knobs (src/jobs/tunables.ts), these are NOT
 * balance constants and do not live in the @caravan/content registry: none of them enters a
 * resolution, a price, a reward or anything a player commits a resource against. They decide
 * only how notifications are grouped and how far back the inbox looks. Each is TUNABLE.
 */

/** The categories PHASE-2 §29 names for group A (season / contract events arrive with group B). */
export const INBOX_CATEGORIES = ["party_strike", "refugees_arrived", "trip_cap_refilled", "mine_near_cap", "packs_rotated", "party_changed"] as const;
export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

/**
 * PHASE-2 §29: "per-category opt-out, defaulting on for party strikes and off for everything
 * else" — amended by the final play-test review (D7): "refugees ready" and "trip cap refilled"
 * are the play test's return hooks and default ON; the mine and the pack rotation stay off. The
 * S2 notice "your standing party changed" (party_changed) defaults on, like party strikes.
 * Migrations 015 / 026 mirror the names.
 */
export const INBOX_CATEGORY_DEFAULTS: Readonly<Record<InboxCategory, boolean>> = {
  party_strike: true,
  refugees_arrived: true,
  trip_cap_refilled: true,
  mine_near_cap: false,
  packs_rotated: false,
  party_changed: true,
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

/** TUNABLE (final play-test review S2). Most "your standing party changed" notices listed (newest first, inside the horizon). */
export const INBOX_MAX_PARTY_CHANGE_ITEMS = 10;

/** TUNABLE (final play-test review r4 N6). Party changes of one reason this close together are one notice. Presentation, not balance. */
export const INBOX_PARTY_CHANGE_COALESCE_MS = 60_000;

/** TUNABLE (r4 N6). Most `standing_party_repaired` events read to build those notices (newest first). */
export const INBOX_MAX_PARTY_CHANGE_EVENTS = 100;

/** TUNABLE. Strikes itemized inside one batch (each with its own replay link); the rest are counted, not listed. */
export const INBOX_STRIKES_PER_ITEM = 10;

/**
 * TUNABLE (chunk 29 QA S4). Only the newest this-many batches carry their strike lines in
 * `GET /me/inbox`; an older batch carries its totals, and its lines are fetched when the player
 * opens it (`GET /me/inbox/strikes/:window`). Keeps the page light for a busy party.
 */
export const INBOX_ITEMIZED_BATCHES = 3;

/**
 * TUNABLE. "Mine near cap": the balance (with pending trickle) is at or above this percent of
 * the storage cap. The trickle stops at the cap (chunk 16), so this is the "about to stop" line.
 */
export const INBOX_MINE_NEAR_CAP_PERCENT = 90;

/** TUNABLE. Most read marks one request may set ("Mark all read" sends every unread item on screen: at most INBOX_MAX_STRIKE_ITEMS + a handful). */
export const INBOX_MAX_MARKS_PER_REQUEST = 100;
