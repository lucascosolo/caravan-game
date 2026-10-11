/**
 * Chunk 30 account-lifecycle knobs. Operational, not balance (like src/jobs/tunables.ts and
 * src/inbox/tunables.ts): none of them enters a resolution, a price or a reward, so they do
 * not live in the @caravan/content registry. Each is TUNABLE.
 */

/** TUNABLE. A device credential's lifetime, sliding: every resume moves it this far forward. */
export const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** TUNABLE. Live bearer sessions one device keeps (several tabs on one browser); the oldest goes first. */
export const DEVICE_SESSIONS_MAX = 3;

/** TUNABLE. Devices one account keeps; signing in on another evicts the least recently seen. */
export const DEVICES_PER_ACCOUNT_MAX = 10;

/** The HttpOnly cookie that carries the device credential. Never readable by the page. */
export const DEVICE_COOKIE = "caravan_device";

/** The exact phrase the delete request must carry (the client shows it and asks the player to type it). */
export const DELETE_CONFIRM_PHRASE = "delete my account";

export interface RateRule {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * TUNABLE. Fixed-window limits, per process (an in-memory counter: a multi-instance deploy
 * needs a shared store, see the chunk 30 build notes). Keyed by client IP, and for login also
 * by the username tried, so neither one address nor one target can be hammered.
 */
export const RATE_LIMITS = {
  loginPerIp: { limit: 20, windowMs: 15 * 60_000 },
  loginPerUsername: { limit: 10, windowMs: 15 * 60_000 },
  registerPerIp: { limit: 10, windowMs: 60 * 60_000 },
  guestPerIp: { limit: 10, windowMs: 60 * 60_000 },
  resumePerIp: { limit: 120, windowMs: 15 * 60_000 },
  linkPerAccount: { limit: 10, windowMs: 15 * 60_000 },
  exportPerAccount: { limit: 5, windowMs: 60 * 60_000 },
  deletePerAccount: { limit: 10, windowMs: 15 * 60_000 },
} as const satisfies Record<string, RateRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;
export type RateLimitConfig = { readonly [K in RateLimitName]: RateRule };
