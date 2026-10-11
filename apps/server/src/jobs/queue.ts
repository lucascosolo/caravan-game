/**
 * Resolution job queue: enqueue, lease, complete, fail/retry, park. No background ticking —
 * every function here runs once when called and returns.
 *
 * Job ids are deterministic: the enqueuer derives them from what is being resolved (see
 * encounterJobId). Enqueueing the same id twice is a no-op that returns the existing row.
 * Completion is guarded by the job row lock + status (see lockJobForCompletion), so a job
 * commits exactly once however many workers end up holding it. The attempt counter fences
 * only failure bookkeeping: a stale worker's failure cannot clobber a live lease.
 */
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import type { JobStatus, ResolutionJobRow } from "../db/types.js";
import type { JsonObject } from "../ledger/events.js";
import { canonicalJson } from "../ledger/events.js";
import { JOB_MAX_ATTEMPTS, JOB_VISIBILITY_TIMEOUT_MS } from "./tunables.js";

export const JOB_KIND_ENCOUNTER_RESOLUTION = "encounter_resolution";

/** Deterministic id for the resolution of one encounter of one trip. */
export function encounterJobId(tripId: string, encounterIndex: number): string {
  if (!Number.isInteger(encounterIndex) || encounterIndex < 0) throw new RangeError("encounterIndex must be a non-negative integer");
  if (!tripId) throw new RangeError("tripId is required");
  return `encounter:${tripId}:${encounterIndex}`;
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
 * Insert a job, or return the one already there under that id. Idempotent. The input of
 * an existing job is never replaced (the DB refuses it too).
 */
export async function enqueueJob(db: Queryable, input: EnqueueInput): Promise<{ job: ResolutionJobRow; created: boolean }> {
  const res = await db.query<ResolutionJobRow>(
    `INSERT INTO resolution_job (id, kind, account_id, caravan_id, input, max_attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [input.id, input.kind, input.accountId, input.caravanId, canonicalJson(input.input), input.maxAttempts ?? JOB_MAX_ATTEMPTS],
  );
  const created = res.rows[0];
  if (created) return { job: created, created: true };
  const existing = await getJob(db, input.id);
  if (!existing) throw new Error(`job ${input.id} vanished between conflict and read`);
  return { job: existing, created: false };
}

export async function getJob(db: Queryable, id: string): Promise<ResolutionJobRow | null> {
  const res = await db.query<ResolutionJobRow>("SELECT * FROM resolution_job WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

/**
 * Lease the next ready job (queued, or leased with an expired lease), oldest first.
 * SKIP LOCKED lets any number of workers call this concurrently without serializing on
 * each other. Returns null when nothing is ready. A job whose lease would exceed
 * max_attempts is parked instead and the search continues.
 */
export async function leaseNextJob(
  db: Queryable,
  workerId: string,
  visibilityTimeoutMs: number = JOB_VISIBILITY_TIMEOUT_MS,
): Promise<ResolutionJobRow | null> {
  // Loop only to skip over rows that get parked on this pass.
  for (;;) {
    const res = await db.query<ResolutionJobRow>(
      `WITH next AS (
         SELECT id FROM resolution_job
         WHERE status = 'queued' OR (status = 'leased' AND lease_expires_at < now())
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE resolution_job j SET
         attempts         = j.attempts + 1,
         status           = CASE WHEN j.attempts + 1 > j.max_attempts THEN 'parked'::job_status ELSE 'leased'::job_status END,
         leased_by        = $1,
         lease_expires_at = CASE WHEN j.attempts + 1 > j.max_attempts THEN NULL ELSE now() + ($2::int * interval '1 millisecond') END,
         last_error       = CASE WHEN j.attempts + 1 > j.max_attempts THEN coalesce(j.last_error, 'lease expired') ELSE j.last_error END
       FROM next WHERE j.id = next.id
       RETURNING j.*`,
      [workerId, visibilityTimeoutMs],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.status === "leased") return row;
    // parked on this pass; look for another
  }
}

/**
 * Inside the worker's completion transaction: lock the job row and confirm nobody has
 * completed it. FIRST VALID COMPLETION WINS: a worker whose lease expired and was
 * re-leased by another may still commit if it gets there first, because its result is a
 * pure function of the immutable input and therefore identical to what the other worker
 * would commit. The row lock (FOR UPDATE) makes the status check and the commit atomic,
 * so exactly one completion lands; the later one sees 'completed' and commits nothing.
 * Fencing completion on the attempt number instead would let a lease shorter than the
 * handler's runtime starve every worker in turn (each re-lease invalidating the last).
 * Returns the fresh row, or null if the job is already completed.
 */
export async function lockJobForCompletion(client: pg.PoolClient, jobId: string): Promise<ResolutionJobRow | null> {
  const res = await client.query<ResolutionJobRow>("SELECT * FROM resolution_job WHERE id = $1 FOR UPDATE", [jobId]);
  const row = res.rows[0];
  if (!row || row.status === "completed") return null;
  return row;
}

export async function markJobCompleted(client: pg.PoolClient, jobId: string, result: JsonObject): Promise<ResolutionJobRow> {
  const res = await client.query<ResolutionJobRow>(
    `UPDATE resolution_job SET status = 'completed', result = $2::jsonb, completed_at = now(),
       lease_expires_at = NULL, last_error = NULL
     WHERE id = $1 RETURNING *`,
    [jobId, canonicalJson(result)],
  );
  return res.rows[0]!;
}

/**
 * Record a failed attempt: back to queued for another try, or parked once max_attempts
 * is reached. Fenced on the attempt number; a superseded lease records nothing.
 */
export async function markJobFailed(
  db: Queryable,
  jobId: string,
  fenceAttempt: number,
  error: string,
): Promise<ResolutionJobRow | null> {
  const res = await db.query<ResolutionJobRow>(
    `UPDATE resolution_job SET
       status = CASE WHEN attempts >= max_attempts THEN 'parked'::job_status ELSE 'queued'::job_status END,
       lease_expires_at = NULL,
       last_error = $3
     WHERE id = $1 AND status = 'leased' AND attempts = $2
     RETURNING *`,
    [jobId, fenceAttempt, error.slice(0, 2000)],
  );
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
