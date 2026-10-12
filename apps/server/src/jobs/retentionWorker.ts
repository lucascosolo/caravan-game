/**
 * PHASE-2 §36 — the scheduled retention job: LOG_RETENTION and LOG_SIZE_BUDGET enforced across
 * every caravan, in-process, like the encounter worker (jobs/inProcessWorker.ts).
 *
 * The completion transaction already compacts the caravan it just wrote to (encounter_log_prune,
 * migration 022), but a caravan that stops playing never writes again — its logs would outlive
 * the window forever. So every `intervalMs` (and once at start) the server runs
 * `encounter_log_retention_sweep(batch)` until a call compacts fewer than `batch` rows (or
 * `maxBatchesPerRun` is reached; the next run carries on). Each call is its own short
 * transaction; the rule (age AND outside the caravan's newest N, or over the size budget), the
 * clock (the database's) and the window (the constant encounter_log_retention row) all live in
 * the definer — nothing here can widen it. Expired logs are COMPACTED to their results summary
 * (encounter_log_summary), never deleted outright, so the feed and the replay summary keep their
 * history.
 *
 * Any number of server processes may run one: two sweeps racing on one row serialize on its row
 * lock, and the loser's delete finds nothing (the summary insert is ON CONFLICT DO NOTHING).
 * Errors are logged, never thrown.
 *
 * QA-36 S2: the same hourly run then erases expired guests — chunk 30's hand-off: a guest with no
 * live device or session, older than DEVICE_TTL (180 days), is erased by account_erase_expired_guests
 * (anonymizing what other players share with it, exactly as a requested deletion). Independent of
 * the log sweep: an error in one never skips the other.
 */
import type pg from "pg";
import { sweepEncounterLogRetention } from "../replay/store.js";

/** Chunk 30's definer (migration 023): erase at most `limit` guests nobody can reach any more. Returns how many. */
export async function eraseExpiredGuests(db: pg.Pool, limit: number): Promise<number> {
  const res = await db.query<{ n: number }>("SELECT account_erase_expired_guests($1) AS n", [limit]);
  return res.rows[0]?.n ?? 0;
}

/** Operational, not balance: how often the sweep runs. Retention is measured in days; hourly is ample. */
export const LOG_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Operational: rows compacted per sweep call (one transaction). */
export const LOG_RETENTION_SWEEP_BATCH = 500;
/** Operational: calls per run; a larger backlog continues on the next run. */
export const LOG_RETENTION_SWEEP_MAX_BATCHES = 200;
/**
 * QA-36 S2 (chunk 30's hand-off): expired guests erased per call of account_erase_expired_guests —
 * small, because each call is one transaction holding every erased account's rows. Operational.
 */
export const GUEST_ERASURE_BATCH = 50;
/** Operational: guest-erasure calls per run; the rest continue on the next run. */
export const GUEST_ERASURE_MAX_BATCHES = 20;

export interface RetentionLoopOptions {
  readonly intervalMs?: number;
  readonly batch?: number;
  readonly maxBatchesPerRun?: number;
  readonly guestBatch?: number;
  readonly guestMaxBatchesPerRun?: number;
  readonly onError: (err: unknown) => void;
  /** Called after every run that compacted or erased something (logging). */
  readonly onRun?: (r: RetentionRun) => void;
}

export interface RetentionRun {
  readonly compacted: number;
  readonly batches: number;
  /** QA-36 S2: guests nobody can reach any more, erased (chunk 30's account_erase_expired_guests). */
  readonly guestsErased: number;
  readonly guestBatches: number;
  /** Which steps failed this run (each is reported through onError; one never skips the other). */
  readonly failed: readonly ("logs" | "guests")[];
  readonly ms: number;
}

export class LogRetentionLoop {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<RetentionRun | null> | null = null;
  private stopped = true;

  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: RetentionLoopOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.runNow(), this.opts.intervalMs ?? LOG_RETENTION_SWEEP_INTERVAL_MS);
    void this.runNow();
  }

  /**
   * One run, two independent steps: (1) the log sweep, in batches until the backlog is drained or
   * the per-run cap is reached; (2) QA-36 S2, the erasure of expired guests (no live device or
   * session, older than DEVICE_TTL — chunk 30's rule, in its definer), likewise batched and capped.
   * An error in one step is reported and never skips the other. Null only when stopped.
   */
  runNow(): Promise<RetentionRun | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.running) return this.running;
    this.running = (async () => {
      const t0 = Date.now();
      const failed: ("logs" | "guests")[] = [];
      const batched = async (step: "logs" | "guests", size: number, max: number, call: (n: number) => Promise<number>): Promise<{ total: number; batches: number }> => {
        let total = 0;
        let batches = 0;
        try {
          while (!this.stopped && batches < max) {
            const n = await call(size);
            batches++;
            total += n;
            if (n < size) break;
          }
        } catch (err) {
          failed.push(step);
          this.opts.onError(err);
        }
        return { total, batches };
      };
      try {
        const logs = await batched("logs", this.opts.batch ?? LOG_RETENTION_SWEEP_BATCH, this.opts.maxBatchesPerRun ?? LOG_RETENTION_SWEEP_MAX_BATCHES, (n) => sweepEncounterLogRetention(this.pool, n));
        const guests = await batched("guests", this.opts.guestBatch ?? GUEST_ERASURE_BATCH, this.opts.guestMaxBatchesPerRun ?? GUEST_ERASURE_MAX_BATCHES, (n) => eraseExpiredGuests(this.pool, n));
        const run: RetentionRun = { compacted: logs.total, batches: logs.batches, guestsErased: guests.total, guestBatches: guests.batches, failed, ms: Date.now() - t0 };
        if (run.compacted > 0 || run.guestsErased > 0) this.opts.onRun?.(run);
        return run;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }
}
