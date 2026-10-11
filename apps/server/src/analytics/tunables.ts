/**
 * Chunk 32 telemetry knobs. Like the job and inbox knobs (src/jobs/tunables.ts,
 * src/inbox/tunables.ts) these are NOT balance constants and do not live in the
 * @caravan/content registry: none enters a resolution, a price, a reward, a menu or anything
 * a player commits a resource against. They bound what the client may send and how the
 * dashboard reads. Each is TUNABLE.
 */

/**
 * The client's screen vocabulary: the web router's routes plus the first-session welcome
 * screen. Closed, so a screen-flow event can never carry free text. A test compares this
 * with apps/web/src/telemetry/screens.ts.
 */
export const TELEMETRY_SCREENS = ["town", "trail", "party", "webs", "packs", "cosmetics", "inbox", "login", "welcome", "admin"] as const;
export type TelemetryScreen = (typeof TELEMETRY_SCREENS)[number];

/** Closed set of crash classes. Anything else the client sees is reported as `Unknown`. */
export const TELEMETRY_ERROR_NAMES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "ApiError", "ChunkLoadError", "Unknown"] as const;
export type TelemetryErrorName = (typeof TELEMETRY_ERROR_NAMES)[number];

/** TUNABLE. Hard cap on one ingest body, in bytes (Fastify answers 413 above it). */
export const TELEMETRY_BODY_LIMIT_BYTES = 4096;

/** TUNABLE. Most events in one batch. */
export const TELEMETRY_MAX_EVENTS_PER_BATCH = 25;

/** TUNABLE. Oldest an event may claim to be (`agoMs`), so a client cannot back-date history. */
export const TELEMETRY_MAX_AGO_MS = 3_600_000;

/** TUNABLE. Ingest batches one account may send per rate window (in-process fixed window). */
export const TELEMETRY_BATCHES_PER_WINDOW = 12;
export const TELEMETRY_RATE_WINDOW_MS = 60_000;

/** TUNABLE. Most events kept per analytics id over a rolling 24 h; the rest are dropped. */
export const TELEMETRY_DAILY_EVENT_CAP = 1000;

/** TUNABLE. Most account keys the in-process limiter tracks before it sweeps stale windows. */
export const TELEMETRY_LIMITER_MAX_KEYS = 10_000;

/** TUNABLE. A gap longer than this between two screen events starts a new session. */
export const ANALYTICS_SESSION_GAP_MS = 30 * 60_000;

/** TUNABLE. Dashboard window, in days: the default and the widest an admin may ask for. */
export const ANALYTICS_DEFAULT_WINDOW_DAYS = 30;
export const ANALYTICS_MAX_WINDOW_DAYS = 120;

/** TUNABLE. Accounts created this many days before now form the day-1/7/30 return cohort. */
export const ANALYTICS_RETENTION_COHORT_DAYS = 90;

/** TUNABLE. "Near the storage cap": a balance at or above this percent of the cap. */
export const ANALYTICS_NEAR_CAP_PERCENT = 90;

/** TUNABLE. A fight that ends at or beyond this share (basis points) of the tick cap is "near the cap". */
export const ANALYTICS_NEAR_TICK_CAP_BP = 9000;
