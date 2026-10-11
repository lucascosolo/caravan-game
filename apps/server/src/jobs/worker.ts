/**
 * The job worker: lease one job, run its pure handler, commit the handler's events and
 * the job's completion in ONE transaction under the caravan's resolution lock.
 *
 * Not a loop that lives in the background. `runOnce` handles at most one job and returns;
 * `drain` repeats `runOnce` until the queue has nothing ready. Whoever calls them (a
 * request handler, a test, an operator command) decides when resolution happens.
 *
 * Handlers are PURE: (job input) -> (events, result). They see nothing but the job's
 * snapshotted input — no clock, no database, no account flags — so running the same job
 * twice yields the same event stream, and nothing about billing can reach a resolution.
 */
import type pg from "pg";
import type { ResolutionJobRow } from "../db/types.js";
import {
  canonicalJson,
  eventIdentity,
  type Json,
  type JsonObject,
  type LedgerEventDraft,
  type LedgerEventIdentity,
} from "../ledger/events.js";
import { appendEvents, listEventsByCausation, lockCaravanForResolution } from "../ledger/ledger.js";
import { getJob, leaseNextJob, lockJobForCompletion, markJobCompleted, markJobFailed } from "./queue.js";
import { JOB_VISIBILITY_TIMEOUT_MS } from "./tunables.js";

export interface HandlerOutput {
  events: LedgerEventDraft[];
  result: JsonObject;
}

export type JobHandler = (job: { id: string; kind: string; accountId: string; caravanId: string; input: JsonObject }) => HandlerOutput;

export type HandlerRegistry = Readonly<Record<string, JobHandler>>;

export type RunOutcome =
  | { kind: "idle" }
  | { kind: "completed"; job: ResolutionJobRow; eventCount: number }
  | { kind: "superseded"; jobId: string }
  | { kind: "failed"; job: ResolutionJobRow | null; jobId: string; error: string };

export interface WorkerOptions {
  workerId: string;
  handlers: HandlerRegistry;
  visibilityTimeoutMs?: number;
  /** Test hook: runs after the lease and before the completion transaction. */
  beforeComplete?: (job: ResolutionJobRow) => Promise<void>;
  /** Test hook: runs inside the completion transaction after events are appended. */
  afterAppend?: (job: ResolutionJobRow, client: pg.PoolClient) => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Invoke a handler for a job without touching the database. Used by replay checks. */
export function dryRunJob(handlers: HandlerRegistry, job: ResolutionJobRow): HandlerOutput {
  const handler = handlers[job.kind];
  if (!handler) throw new Error(`no handler registered for job kind '${job.kind}'`);
  return handler({ id: job.id, kind: job.kind, accountId: job.account_id, caravanId: job.caravan_id, input: job.input as JsonObject });
}

/** Lease and run at most one job. */
export async function runOnce(pool: pg.Pool, opts: WorkerOptions): Promise<RunOutcome> {
  const leased = await leaseNextJob(pool, opts.workerId, opts.visibilityTimeoutMs ?? JOB_VISIBILITY_TIMEOUT_MS);
  if (!leased) return { kind: "idle" };
  const fence = leased.attempts;

  try {
    if (opts.beforeComplete) await opts.beforeComplete(leased);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // TRIP_LOCK_MODE: one resolution at a time per caravan.
      await lockCaravanForResolution(client, leased.caravan_id);
      const job = await lockJobForCompletion(client, leased.id);
      if (!job) {
        await client.query("ROLLBACK");
        return { kind: "superseded", jobId: leased.id };
      }
      const output = dryRunJob(opts.handlers, job);
      const rows = await appendEvents(client, job.id, output.events);
      if (opts.afterAppend) await opts.afterAppend(job, client);
      const completed = await markJobCompleted(client, job.id, output.result);
      await client.query("COMMIT");
      return { kind: "completed", job: completed, eventCount: rows.length };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const message = errorMessage(err);
    const job = await markJobFailed(pool, leased.id, fence, message);
    return { kind: "failed", job, jobId: leased.id, error: message };
  }
}

/** Run jobs until the queue reports nothing ready. Returns everything that happened. */
export async function drain(pool: pg.Pool, opts: WorkerOptions, maxJobs = 10_000): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  for (let i = 0; i < maxJobs; i++) {
    const outcome = await runOnce(pool, opts);
    if (outcome.kind === "idle") break;
    outcomes.push(outcome);
  }
  return outcomes;
}

export interface ReplayCheck {
  ok: boolean;
  stored: LedgerEventIdentity[];
  replayed: LedgerEventIdentity[];
}

/**
 * Determinism probe: re-run a completed job's handler on its stored input and compare
 * with the events that were committed. Nothing is written.
 */
export async function verifyJobReplay(pool: pg.Pool, handlers: HandlerRegistry, jobId: string): Promise<ReplayCheck> {
  const job = await getJob(pool, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  if (job.status !== "completed") throw new Error(`job ${jobId} is ${job.status}, not completed`);
  const storedRows = await listEventsByCausation(pool, jobId);
  const stored = storedRows.map(eventIdentity);
  const replayed: LedgerEventIdentity[] = dryRunJob(handlers, job).events.map((d, i) => ({
    type: d.type,
    accountId: d.accountId,
    caravanId: d.caravanId ?? null,
    causationId: job.id,
    causationSeq: i,
    resolverVersion: d.resolverVersion ?? null,
    payload: d.payload,
  }));
  const key = (xs: LedgerEventIdentity[]): string => canonicalJson(xs as unknown as Json);
  return { ok: key(stored) === key(replayed), stored, replayed };
}
