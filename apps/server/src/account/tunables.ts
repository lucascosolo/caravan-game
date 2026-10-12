/**
 * Chunk 30 account-lifecycle knobs. Operational, not balance: none of them enters a
 * resolution, a price or a reward. The rate limits live in the @caravan/content registry
 * (TUNABLES.ACCOUNT_RATE_LIMITS, QA-30 D3); the rest are here. Each is TUNABLE.
 */
import { TUNABLES } from "@caravan/content";

/** TUNABLE. A device credential's lifetime, sliding: every resume moves it this far forward. */
export const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * TUNABLE (QA-30 S4: 3 → 10). Live bearer sessions one device keeps — one per open tab of the
 * browser. Beyond it the LEAST RECENTLY USED session goes, so a tab in use is never the one evicted.
 */
export const DEVICE_SESSIONS_MAX = 10;

/** TUNABLE. Devices one account keeps; signing in on another evicts the least recently seen. */
export const DEVICES_PER_ACCOUNT_MAX = 10;

/** How often a session's last_used_at is refreshed (one write per session per this long, not per request). */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

/** The HttpOnly cookie that carries the device credential. Never readable by the page. */
export const DEVICE_COOKIE = "caravan_device";

/** The exact phrase the delete request must carry (the client shows it and asks the player to type it). */
export const DELETE_CONFIRM_PHRASE = "delete my account";

/** TUNABLE (QA-30 D4 / N10). An export larger than this is refused (413 `export_too_large`) rather than built in memory without bound. */
export const EXPORT_MAX_BYTES = 20 * 1024 * 1024;

export interface RateRule {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowMs: number;
}

/** The registry's limits (TUNABLES.ACCOUNT_RATE_LIMITS). Counted in memory, per process. */
export const RATE_LIMITS = TUNABLES.ACCOUNT_RATE_LIMITS;

export type RateLimitName = keyof typeof RATE_LIMITS;
export type RateLimitConfig = { readonly [K in RateLimitName]: RateRule };
