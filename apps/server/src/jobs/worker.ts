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
 *
 * What the worker adds between handler and ledger, and nothing else:
 *   - the completion FENCE (QA-02 B1): commit only while this worker's lease is live;
 *   - a resolver-version check (QA-02 B1a): a job enqueued for another RESOLVER_VERSION
 *     is failed, not resolved with the wrong code;
 *   - the Coin cap clamp (QA-02 S6): committed stream = handler stream with each credit
 *     clamped to the room left and `overflowDiscarded` recorded (see clampCoinCreditDrafts).
 */
import { RESOLVER_VERSION } from "@caravan/resolver";
import type pg from "pg";
import type { ResolutionJobRow } from "../db/types.js";
import { clampCoinCreditDrafts, requestedCreditAmount } from "../ledger/coin.js";
import {
  COIN_CREDIT_TYPES,
  canonicalJson,
  eventIdentity,
  type CoinPayload,
  type Json,
  type JsonObject,
  type LedgerEventDraft,
  type LedgerEventIdentity,
} from "../ledger/events.js";
import { appendEvents, listEventsByCausation, lockAccountsForAppend, lockCaravanForResolution } from "../ledger/ledger.js";
import {
  NonRetryableJobError,
  getJob,
  leaseNextJob,
  lockJobForCompletion,
  markJobCompleted,
  markJobFailed,
  markJobParked,
  retryBackoffMs,
  type LeaseFence,
} from "./queue.js";
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
  | { kind: "failed"; job: ResolutionJobRow | null; jobId: string; error: string }
  | { kind: "parked"; job: ResolutionJobRow | null; jobId: string; error: string };

export interface WorkerOptions {
  workerId: string;
  handlers: HandlerRegistry;
  visibilityTimeoutMs?: number;
  /** Backoff before a failed attempt is retried; default exponential (tunables). Tests pass () => 0. */
  retryBackoffMs?: (attempts: number) => number;
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

/**
 * A job enqueued against one resolver version must not be resolved by another (GUARDRAILS
 * §1: the replay is only meaningful against the resolver that produced it). Retryable, so
 * a worker running the right version can still pick it up during a rolling deploy.
 */
export function assertResolverVersionMatches(job: ResolutionJobRow): void {
  const expected = (job.input as JsonObject)["resolverVersion"];
  if (expected !== undefined && expected !== RESOLVER_VERSION) {
    throw new Error(`resolver version mismatch: job ${job.id} was enqueued for resolver v${String(expected)}, this worker runs v${RESOLVER_VERSION}`);
  }
}

/** Lease and run at most one job. */
export async function runOnce(pool: pg.Pool, opts: WorkerOptions): Promise<RunOutcome> {
  const leased = await leaseNextJob(pool, opts.workerId, opts.visibilityTimeoutMs ?? JOB_VISIBILITY_TIMEOUT_MS);
  if (!leased) return { kind: "idle" };
  const fence: LeaseFence = { workerId: opts.workerId, attempts: leased.attempts };
  const backoff = opts.retryBackoffMs ?? retryBackoffMs;

  try {
    assertResolverVersionMatches(leased);
    if (opts.beforeComplete) await opts.beforeComplete(leased);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // TRIP_LOCK_MODE: one resolution at a time per caravan.
      await lockCaravanForResolution(client, leased.caravan_id);
      const job = await lockJobForCompletion(client, leased.id, fence);
      if (!job) {
        await client.query("ROLLBACK");
        return { kind: "superseded", jobId: leased.id };
      }
      const output = dryRunJob(opts.handlers, job);
      // Every account this batch touches, locked up front in sorted order (QA-02 S5),
      // then the cap clamp under those locks (QA-02 S6), then the append.
      await lockAccountsForAppend(client, output.events.map((d) => d.accountId));
      const drafts = await clampCoinCreditDrafts(client, output.events);
      const rows = await appendEvents(client, job.id, drafts);
      if (opts.afterAppend) await opts.afterAppend(job, client);
      const completed = await markJobCompleted(client, job.id, output.result, fence);
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
    if (err instanceof NonRetryableJobError) {
      const job = await markJobParked(pool, leased.id, fence.attempts, message, { workerId: fence.workerId });
      return { kind: "parked", job, jobId: leased.id, error: message };
    }
    const job = await markJobFailed(pool, leased.id, fence.attempts, message, { workerId: fence.workerId, backoffMs: backoff(fence.attempts) });
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
 * The deterministic view of an event for replay comparison: a Coin credit is compared on
 * the amount the handler REQUESTED (amount + overflowDiscarded), because what the cap
 * swallowed at commit depends on the balance then, not on the job's input.
 */
export function replayIdentity(ev: LedgerEventIdentity): LedgerEventIdentity {
  if (!COIN_CREDIT_TYPES.has(ev.type)) return ev;
  const { overflowDiscarded: _o, ...rest } = ev.payload as CoinPayload;
  return { ...ev, payload: { ...rest, amount: requestedCreditAmount(ev.payload as CoinPayload) } };
}

/**
 * Determinism probe: re-run a completed job's handler on its stored input and compare
 * with the events that were committed (modulo the cap clamp, see replayIdentity).
 * Nothing is written.
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
  const key = (xs: LedgerEventIdentity[]): string => canonicalJson(xs.map(replayIdentity) as unknown as Json);
  return { ok: key(stored) === key(replayed), stored, replayed };
}
