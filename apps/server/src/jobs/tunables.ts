/**
 * Chunk 02 server-side infrastructure knobs. Defaults from
 * roadmap/chunks/02-ledger-and-job-queue.md.
 *
 * These are NOT balance constants and do not live in the @caravan/content tunables
 * registry, by decision (chunk 03 QA S6, chunk 02 QA N4): retries, lease windows, backoff
 * and checkpoint cadence never enter resolution or any player-visible number. They are
 * deployment knobs. Changing one changes throughput and recovery behaviour, never an
 * outcome — a job resolved after three retries commits the same events as one resolved
 * first time (GUARDRAILS §1). Each is marked TUNABLE and may be overridden per call where
 * the function takes a parameter.
 */

/** TUNABLE. Leases taken before a job is parked for inspection. */
export const JOB_MAX_ATTEMPTS = 3;

/**
 * TUNABLE. Lease window for an in-flight job; an expired lease may be re-leased, and a
 * worker whose lease has expired can no longer commit (QA-02 B1). This MUST exceed the
 * handler's worst-case runtime plus the commit transaction; a lease shorter than the
 * handler loses every attempt and parks the job with last_error 'lease expired'.
 */
export const JOB_VISIBILITY_TIMEOUT_MS = 30_000;

/**
 * TUNABLE. Retry backoff after a failed attempt (QA-02 N3): attempt n waits
 * BASE * 2^(n-1), capped at MAX, before it is ready again. Pure scheduling; an attempt
 * resolved later commits the same events.
 */
export const JOB_RETRY_BACKOFF_BASE_MS = 1_000;
export const JOB_RETRY_BACKOFF_MAX_MS = 60_000;

/**
 * TUNABLE (documentation value). Encounter resolutions are serialized per caravan by a
 * transaction-scoped advisory lock keyed on the caravan id. Standing parties need no
 * lock: they are snapshotted into the job input and never mutated by a fight.
 */
export const TRIP_LOCK_MODE = "caravan_advisory_xact_lock" as const;

/** TUNABLE. Projection checkpoint cadence, in events per account. Pure perf knob. */
export const LEDGER_SNAPSHOT_INTERVAL = 500;
