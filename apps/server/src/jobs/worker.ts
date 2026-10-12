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
import { TUNABLES } from "@caravan/content";
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
import { pruneEncounterLogs, storeEncounterLog } from "../replay/store.js";

export interface HandlerOutput {
  events: LedgerEventDraft[];
  result: JsonObject;
  /** Chunk 13 (QA-15 S2): the replay log, stored in encounter_log in the completion transaction. */
  encounterLog?: EncounterLogArtifact;
}

/** A resolved encounter's tick log as the handler hands it over: JSON text plus the hashes the row records. */
export interface EncounterLogArtifact {
  jobId: string;
  caravanId: string;
  defenderAccountId: string;
  partyOwnerAccountId: string;
  resolverVersion: number;
  logFormat: number;
  /** The ReplayLog serialized (JSON.stringify of the resolver package's encodeReplay output). */
  text: string;
  sha256: string;
  formationSha256: string;
  survivorsSha256: string;
  partySha256: string;
  contentHash: string;
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
  /**
   * Chunk 15 QA S4: runs inside the completion transaction, after the job is marked completed,
   * within a SAVEPOINT — a hook that throws is rolled back alone and the completion still
   * commits (reported through `onHookError`). The trip loop passes its settle
   * (trip/service.ts TRIP_SETTLE_HOOKS), so a resolution's effects land with it.
   */
  afterCompleted?: (client: pg.PoolClient, job: ResolutionJobRow) => Promise<void>;
  /** Chunk 15 QA D3: runs after a job PARKS (its own transaction); the trip loop voids the trip. Errors go to `onHookError`. */
  afterParked?: (pool: pg.Pool, job: ResolutionJobRow) => Promise<void>;
  /** Where a failed hook is reported (default: ignored; the lazy settle retries and surfaces it). */
  onHookError?: (err: unknown, job: ResolutionJobRow, hook: "afterCompleted" | "afterParked" | "compaction") => void;
  /**
   * PHASE-2 §36 (QA N2): a stored log above LOG_SIZE_BUDGET — an abnormal fight log (the largest
   * corpus log is ~30 KB of the 100 KB budget). It is compacted to its summary at once, so the
   * defender has no replay of it; the in-process loop logs it as an anomaly.
   */
  onLogOverBudget?: (jobId: string, storedBytes: number, budgetBytes: number) => void;
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
 * §1: the replay is only meaningful against the resolver that produced it). The version
 * is REQUIRED (QA-02 R2-S1): a missing, null, non-integer or string version is a mismatch,
 * never a wildcard. Defense in depth: the lease already filters on the version (R2-S2) and
 * the schema refuses a job without one, so this fires only if one of those is bypassed.
 * Retryable, so a worker running the right version can still pick the job up.
 */
export function assertResolverVersionMatches(job: ResolutionJobRow): void {
  const expected = (job.input as JsonObject)["resolverVersion"];
  if (typeof expected !== "number" || !Number.isInteger(expected)) {
    throw new Error(
      `resolver version mismatch: job ${job.id} has no integer input.resolverVersion (got ${JSON.stringify(expected)}), this worker runs v${RESOLVER_VERSION}`,
    );
  }
  if (expected !== RESOLVER_VERSION) {
    throw new Error(`resolver version mismatch: job ${job.id} was enqueued for resolver v${String(expected)}, this worker runs v${RESOLVER_VERSION}`);
  }
}

/** Lease and run at most one job. Leases only jobs enqueued for this process's RESOLVER_VERSION (QA-02 R2-S2). */
export async function runOnce(pool: pg.Pool, opts: WorkerOptions): Promise<RunOutcome> {
  const leased = await leaseNextJob(pool, opts.workerId, opts.visibilityTimeoutMs ?? JOB_VISIBILITY_TIMEOUT_MS, RESOLVER_VERSION);
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
      // Chunk 13: the replay, stored with the completion (same transaction, fenced on this lease), then the retention prune.
      const storedBytes = output.encounterLog ? await storeEncounterLog(client, output.encounterLog, fence) : 0;
      if (opts.afterAppend) await opts.afterAppend(job, client);
      const completed = await markJobCompleted(client, job.id, output.result, fence);
      // PHASE-2 §36: compaction needs the job's result, so the caravan's prune runs once more now that
      // the job is completed — an over-budget log is compacted before this transaction commits.
      // QA-36 D4: under a SAVEPOINT — storage housekeeping never costs a player their fight. A
      // compaction that fails here is rolled back alone (reported via onHookError) and left to the
      // hourly sweep; the completion still commits.
      if (output.encounterLog) {
        await client.query("SAVEPOINT compaction");
        try {
          await pruneEncounterLogs(client, output.encounterLog.caravanId);
          await client.query("RELEASE SAVEPOINT compaction");
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT compaction");
          opts.onHookError?.(err, completed, "compaction");
        }
        if (storedBytes > TUNABLES.LOG_SIZE_BUDGET_BYTES) opts.onLogOverBudget?.(job.id, storedBytes, TUNABLES.LOG_SIZE_BUDGET_BYTES);
      }
      if (opts.afterCompleted) {
        await client.query("SAVEPOINT after_completed");
        try {
          await opts.afterCompleted(client, completed);
          await client.query("RELEASE SAVEPOINT after_completed");
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT after_completed");
          opts.onHookError?.(err, completed, "afterCompleted");
        }
      }
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
      await runParkedHook(pool, opts, job);
      return { kind: "parked", job, jobId: leased.id, error: message };
    }
    const job = await markJobFailed(pool, leased.id, fence.attempts, message, { workerId: fence.workerId, backoffMs: backoff(fence.attempts) });
    // A retryable failure that spent the attempt budget parks too (markJobFailed decides).
    if (job?.status === "parked") await runParkedHook(pool, opts, job);
    return { kind: "failed", job, jobId: leased.id, error: message };
  }
}

async function runParkedHook(pool: pg.Pool, opts: WorkerOptions, job: ResolutionJobRow | null): Promise<void> {
  if (!opts.afterParked || !job || job.status !== "parked") return;
  try {
    await opts.afterParked(pool, job);
  } catch (err) {
    opts.onHookError?.(err, job, "afterParked");
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
