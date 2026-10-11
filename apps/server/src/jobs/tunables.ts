/**
 * Chunk 02 tunables. Defaults from roadmap/chunks/02-ledger-and-job-queue.md.
 * TODO(chunk-03): move into the @caravan/content tunables registry once it exists; these
 * are defined here only so chunk 02 does not edit packages/content concurrently.
 */

/** TUNABLE. Leases taken before a job is parked for inspection. */
export const JOB_MAX_ATTEMPTS = 3;

/** TUNABLE. Lease window for an in-flight job; an expired lease may be re-leased. */
export const JOB_VISIBILITY_TIMEOUT_MS = 30_000;

/**
 * TUNABLE (documentation value). Encounter resolutions are serialized per caravan by a
 * transaction-scoped advisory lock keyed on the caravan id. Standing parties need no
 * lock: they are snapshotted into the job input and never mutated by a fight.
 */
export const TRIP_LOCK_MODE = "caravan_advisory_xact_lock" as const;

/** TUNABLE. Projection checkpoint cadence, in events per account. Pure perf knob. */
export const LEDGER_SNAPSHOT_INTERVAL = 500;
