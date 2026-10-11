/**
 * Chunk 13 QA round 1 (S1): the RUNNING SERVER resolves encounters. Before this, only tests
 * called `drain` / `runOnce` — `pnpm dev` / `pnpm start` left every committed encounter `queued`
 * forever, so no running server could produce a replay.
 *
 * `EncounterWorkerLoop` drains the job queue IN-PROCESS with the handlers it is given — the
 * production DEFAULT_HANDLERS (the real resolver) unless the dev/test flag
 * CARAVAN_TEST_RESOLVER=double (src/dev/testResolver.ts) swaps in chunk 15's test double for
 * predictable e2e outcomes. It runs
 *   - shortly after every encounter commit (`kick()`, from routes/trip.ts), and
 *   - every `pollMs` regardless, so a retry whose backoff has passed, a lease that expired in a
 *     crashed process, or a job committed through another server is picked up.
 * At most one drain runs at a time per process; a kick during a drain runs another pass after it.
 * Any number of server processes may run one: the queue's lease (SKIP LOCKED, the completion
 * fence) is what makes concurrent workers safe, not this loop. The worker id is unique per
 * process. Errors are logged, never thrown into a request.
 *
 * Nothing about resolution changes here: the worker (jobs/worker.ts) still runs the pure handler
 * and commits events, the stored replay and the completion in one transaction.
 */
import { hostname } from "node:os";
import type pg from "pg";
import { drain, type HandlerRegistry, type RunOutcome } from "./worker.js";

/** Operational, not balance: how often an idle server looks for ready jobs. */
export const ENCOUNTER_WORKER_POLL_MS = 1000;

export interface EncounterWorkerLoopOptions {
  readonly handlers: HandlerRegistry;
  /** What the handlers are, for logs ("resolver", "test-double"). */
  readonly name: string;
  readonly workerId?: string;
  readonly pollMs?: number;
  /** Delay between a commit's kick and the drain (the double waits so a client sees "resolving"). */
  readonly kickDelayMs?: number;
  readonly retryBackoffMs?: (attempts: number) => number;
  readonly onError: (err: unknown) => void;
  /** Called with every outcome other than idle (logging). */
  readonly onOutcome?: (outcome: RunOutcome) => void;
}

export class EncounterWorkerLoop {
  readonly workerId: string;
  readonly name: string;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private poll: NodeJS.Timeout | null = null;
  private readonly kicks = new Set<NodeJS.Timeout>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: EncounterWorkerLoopOptions,
  ) {
    this.workerId = opts.workerId ?? `server:${hostname()}:${process.pid}:${opts.name}`;
    this.name = opts.name;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.poll = setInterval(() => void this.runNow(), this.opts.pollMs ?? ENCOUNTER_WORKER_POLL_MS);
    void this.runNow();
  }

  /** A job was just enqueued: drain soon (after kickDelayMs). */
  kick(): void {
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.kicks.delete(t);
      void this.runNow();
    }, this.opts.kickDelayMs ?? 0);
    this.kicks.add(t);
  }

  /** Drain now; resolves when this pass (and any pass a concurrent kick asked for) is done. */
  runNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const outcomes = await drain(this.pool, {
            workerId: this.workerId,
            handlers: this.opts.handlers,
            ...(this.opts.retryBackoffMs ? { retryBackoffMs: this.opts.retryBackoffMs } : {}),
          });
          if (this.opts.onOutcome) for (const o of outcomes) this.opts.onOutcome(o);
        } while (this.again && !this.stopped);
      } catch (err) {
        this.opts.onError(err);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Stop polling and kicking; waits for a drain in progress to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const t of this.kicks) clearTimeout(t);
    this.kicks.clear();
    if (this.running) await this.running;
  }
}
