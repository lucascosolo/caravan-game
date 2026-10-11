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
 */
import type pg from "pg";
import { sweepEncounterLogRetention } from "../replay/store.js";

/** Operational, not balance: how often the sweep runs. Retention is measured in days; hourly is ample. */
export const LOG_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Operational: rows compacted per sweep call (one transaction). */
export const LOG_RETENTION_SWEEP_BATCH = 500;
/** Operational: calls per run; a larger backlog continues on the next run. */
export const LOG_RETENTION_SWEEP_MAX_BATCHES = 200;

export interface RetentionLoopOptions {
  readonly intervalMs?: number;
  readonly batch?: number;
  readonly maxBatchesPerRun?: number;
  readonly onError: (err: unknown) => void;
  /** Called after every run that compacted something (logging). */
  readonly onRun?: (r: RetentionRun) => void;
}

export interface RetentionRun {
  readonly compacted: number;
  readonly batches: number;
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

  /** One run: sweep batches until the backlog is drained or the per-run cap is reached. Null if stopped or the run failed. */
  runNow(): Promise<RetentionRun | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.running) return this.running;
    this.running = (async () => {
      const batch = this.opts.batch ?? LOG_RETENTION_SWEEP_BATCH;
      const max = this.opts.maxBatchesPerRun ?? LOG_RETENTION_SWEEP_MAX_BATCHES;
      const t0 = Date.now();
      let compacted = 0;
      let batches = 0;
      try {
        while (!this.stopped && batches < max) {
          const n = await sweepEncounterLogRetention(this.pool, batch);
          batches++;
          compacted += n;
          if (n < batch) break;
        }
        const run = { compacted, batches, ms: Date.now() - t0 };
        if (compacted > 0) this.opts.onRun?.(run);
        return run;
      } catch (err) {
        this.opts.onError(err);
        return null;
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
