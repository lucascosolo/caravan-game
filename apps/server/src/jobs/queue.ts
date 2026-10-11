/**
 * Resolution job queue: enqueue, lease, complete, fail/retry, park, re-queue. No
 * background ticking — every function here runs once when called and returns.
 *
 * Job ids are deterministic: the enqueuer derives them from what is being resolved (see
 * encounterJobId). Enqueueing the same id with the same input is a no-op that returns the
 * existing row; the same id with a DIFFERENT input is a conflict error (QA-02 S4).
 *
 * COMPLETION FENCE (QA-02 B1). A worker may commit a job only while the row is 'leased'
 * to that worker, at the attempt number its lease was issued with, and the lease has not
 * expired. Anything else — a never-leased job, a parked job, a re-leased job, a lease that
 * ran out while the handler was still running — loses cleanly: the row lock is released,
 * the transaction rolls back, nothing is written. The next lease (or the operator) gets
 * the job. Parked is terminal for workers; only `requeueParkedJob` moves it, back to
 * 'queued'. The attempt counter fences failure bookkeeping the same way.
 *
 * STATUS WRITERS (QA-02 R2-S3). lease / complete / fail / park / requeue are thin calls to
 * the SECURITY DEFINER SQL functions resolution_job_{lease,complete,fail,park,requeue}
 * (migration 002). The app role has no UPDATE privilege on status, the lease, attempts or
 * the requeue audit columns (db/roles.sql), so these functions are the only way a job's
 * state moves, and the guard trigger checks every transition they make. Each runs inside
 * the caller's transaction; a row lock a writer takes is held to COMMIT, exactly as the
 * inline UPDATEs they replaced.
 *
 * VERSION-SCOPED LEASING (QA-02 R2-S2). A lease is for one resolver version: the worker
 * passes the version it runs, and the lease only ever returns jobs enqueued for exactly
 * that version. A job for another version is invisible to this worker — never leased,
 * never charged an attempt, never parked — so a rolling deploy with mixed versions is
 * safe. Every job carries input.resolverVersion (CHECK, QA-02 R2-S1).
 */
import { RESOLVER_VERSION } from "@caravan/resolver";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import type { JobStatus, ResolutionJobRow } from "../db/types.js";
import type { JsonObject } from "../ledger/events.js";
import { canonicalJson } from "../ledger/events.js";
import {
  JOB_MAX_ATTEMPTS,
  JOB_RETRY_BACKOFF_BASE_MS,
  JOB_RETRY_BACKOFF_MAX_MS,
  JOB_VISIBILITY_TIMEOUT_MS,
} from "./tunables.js";

export const JOB_KIND_ENCOUNTER_RESOLUTION = "encounter_resolution";

/** Deterministic id for the resolution of one encounter of one trip. */
export function encounterJobId(tripId: string, encounterIndex: number): string {
  if (!Number.isInteger(encounterIndex) || encounterIndex < 0) throw new RangeError("encounterIndex must be a non-negative integer");
  if (!tripId) throw new RangeError("tripId is required");
  return `encounter:${tripId}:${encounterIndex}`;
}

/** Thrown when an existing job id is re-enqueued with a different input (QA-02 S4). */
export class JobInputConflictError extends Error {
  readonly code = "JOB_INPUT_CONFLICT";
  constructor(
    readonly jobId: string,
    readonly existing: ResolutionJobRow,
  ) {
    super(`job ${jobId} already exists with a different input; a resolution's input is immutable once enqueued`);
    this.name = "JobInputConflictError";
  }
}

/**
 * Thrown by a handler (or the worker) for a failure that retrying cannot fix. The worker
 * parks the job at once with this message as last_error instead of burning attempts.
 */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

/** The proof a worker holds that it may complete or fail a job: its lease. */
export interface LeaseFence {
  workerId: string;
  attempts: number;
}

export interface EnqueueInput {
  id: string;
  kind: string;
  accountId: string;
  caravanId: string;
  input: JsonObject;
  maxAttempts?: number;
}

/**
 * Insert a job, or return the one already there under that id when its input is
 * identical (canonical JSON). Idempotent for retries; a different input for the same id
 * throws JobInputConflictError rather than being silently ignored (the DB refuses to
 * replace an input too).
 */
export async function enqueueJob(db: Queryable, input: EnqueueInput): Promise<{ job: ResolutionJobRow; created: boolean }> {
  const canonical = canonicalJson(input.input);
  const res = await db.query<ResolutionJobRow>(
    `INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [input.id, input.kind, input.accountId, input.caravanId, canonical, input.maxAttempts ?? JOB_MAX_ATTEMPTS],
  );
  const created = res.rows[0];
  if (created) return { job: created, created: true };
  const existing = await getJob(db, input.id);
  if (!existing) throw new Error(`job ${input.id} vanished between conflict and read`);
  if (canonicalJson(existing.input as JsonObject) !== canonical || existing.kind !== input.kind) {
    throw new JobInputConflictError(input.id, existing);
  }
  return { job: existing, created: false };
}

export async function getJob(db: Queryable, id: string): Promise<ResolutionJobRow | null> {
  const res = await db.query<ResolutionJobRow>("SELECT * FROM resolution_job WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

/**
 * Lease the next ready job for a worker running `resolverVersion` (default: this
 * process's RESOLVER_VERSION), oldest first: queued and past its next_attempt_at, or
 * leased with an expired lease, and enqueued for exactly that version (QA-02 R2-S2).
 * SKIP LOCKED lets any number of workers call this concurrently without serializing on
 * each other. Returns null when nothing is ready. A job whose lease would exceed
 * max_attempts is parked instead (with no worker recorded, QA-02 R2-N1) and the search
 * continues. Lease expiry is clock_timestamp()-based (QA-02 R2-N2), like the fence.
 */
export async function leaseNextJob(
  db: Queryable,
  workerId: string,
  visibilityTimeoutMs: number = JOB_VISIBILITY_TIMEOUT_MS,
  resolverVersion: number = RESOLVER_VERSION,
): Promise<ResolutionJobRow | null> {
  if (!Number.isInteger(resolverVersion)) throw new RangeError("resolverVersion must be an integer");
  const res = await db.query<ResolutionJobRow>("SELECT * FROM resolution_job_lease($1, $2::int, $3::int)", [
    workerId,
    visibilityTimeoutMs,
    resolverVersion,
  ]);
  return res.rows[0] ?? null;
}

/**
 * Inside the worker's completion transaction: lock the job row and check the fence.
 * Returns the fresh row only if it is still leased to `fence.workerId` at
 * `fence.attempts` and the lease has not expired (clock_timestamp(), not the transaction
 * start, so a long wait on the caravan lock counts). Otherwise null: the caller rolls
 * back and reports itself superseded. Holding the row lock from here to COMMIT makes the
 * check and the commit atomic — a competing lease (SKIP LOCKED) cannot slip in between.
 */
export async function lockJobForCompletion(client: pg.PoolClient, jobId: string, fence: LeaseFence): Promise<ResolutionJobRow | null> {
  const res = await client.query<ResolutionJobRow & { lease_live: boolean }>(
    "SELECT *, (lease_expires_at > clock_timestamp()) AS lease_live FROM resolution_job WHERE id = $1 FOR UPDATE",
    [jobId],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.status !== "leased" || row.leased_by !== fence.workerId || row.attempts !== fence.attempts || !row.lease_live) return null;
  const { lease_live: _live, ...job } = row;
  return job;
}

/** Record completion. Fenced like lockJobForCompletion; throws if the fence no longer holds. */
export async function markJobCompleted(client: pg.PoolClient, jobId: string, result: JsonObject, fence: LeaseFence): Promise<ResolutionJobRow> {
  const res = await client.query<ResolutionJobRow>("SELECT * FROM resolution_job_complete($1, $2::jsonb, $3, $4::int)", [
    jobId,
    canonicalJson(result),
    fence.workerId,
    fence.attempts,
  ]);
  const row = res.rows[0];
  if (!row) throw new Error(`job ${jobId}: completion fence lost (lease expired or re-leased); nothing committed`);
  return row;
}

/** Exponential backoff before attempt `attempts` (1-based, the one that just failed) is retried. */
export function retryBackoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(JOB_RETRY_BACKOFF_MAX_MS, JOB_RETRY_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 30));
}

/**
 * Record a failed attempt: back to queued for another try after a backoff, or parked once
 * max_attempts is reached. Fenced on the attempt number (and on the worker, when given);
 * a superseded lease records nothing. `backoffMs` overrides the exponential default.
 */
export async function markJobFailed(
  db: Queryable,
  jobId: string,
  fenceAttempt: number,
  error: string,
  opts: { workerId?: string; backoffMs?: number } = {},
): Promise<ResolutionJobRow | null> {
  const backoff = opts.backoffMs ?? retryBackoffMs(fenceAttempt);
  const res = await db.query<ResolutionJobRow>("SELECT * FROM resolution_job_fail($1, $2::int, $3, $4::int, $5::text)", [
    jobId,
    fenceAttempt,
    error.slice(0, 2000),
    Math.max(0, Math.round(backoff)),
    opts.workerId ?? null,
  ]);
  return res.rows[0] ?? null;
}

/** Park a leased job at once (a non-retryable failure). Fenced like markJobFailed. */
export async function markJobParked(
  db: Queryable,
  jobId: string,
  fenceAttempt: number,
  error: string,
  opts: { workerId?: string } = {},
): Promise<ResolutionJobRow | null> {
  const res = await db.query<ResolutionJobRow>("SELECT * FROM resolution_job_park($1, $2::int, $3, $4::text)", [
    jobId,
    fenceAttempt,
    error.slice(0, 2000),
    opts.workerId ?? null,
  ]);
  return res.rows[0] ?? null;
}

/** Who a requeue is recorded as when the caller does not say (QA-02 R2-S3). */
export const DEFAULT_REQUEUED_BY = "operator";

/**
 * Operator path (QA-02 B1c): put a parked job back in the queue. The attempt counter
 * never decreases (trigger), so the budget is extended instead: max_attempts becomes
 * attempts + extraAttempts (default JOB_MAX_ATTEMPTS). last_error is kept for the record
 * until the next attempt overwrites it. The row records who did it and when
 * (requeued_by / requeued_at / requeue_count, QA-02 R2-S3); pass `requeuedBy` to name
 * the operator. Returns null unless the job is parked, so a concurrent double requeue
 * hands the row to exactly one caller.
 */
export async function requeueParkedJob(
  db: Queryable,
  jobId: string,
  opts: { extraAttempts?: number; requeuedBy?: string } = {},
): Promise<ResolutionJobRow | null> {
  const extra = opts.extraAttempts ?? JOB_MAX_ATTEMPTS;
  if (!Number.isInteger(extra) || extra < 1) throw new RangeError("extraAttempts must be a positive integer");
  const by = opts.requeuedBy ?? DEFAULT_REQUEUED_BY;
  if (typeof by !== "string" || by.length === 0) throw new RangeError("requeuedBy must be a non-empty string");
  const res = await db.query<ResolutionJobRow>("SELECT * FROM resolution_job_requeue($1, $2::int, $3)", [jobId, extra, by]);
  return res.rows[0] ?? null;
}

export async function countJobsByStatus(db: Queryable): Promise<Record<JobStatus, number>> {
  const res = await db.query<{ status: JobStatus; n: string }>(
    "SELECT status, count(*)::text AS n FROM resolution_job GROUP BY status",
  );
  const out: Record<JobStatus, number> = { queued: 0, leased: 0, completed: 0, parked: 0 };
  for (const r of res.rows) out[r.status] = Number(r.n);
  return out;
}
