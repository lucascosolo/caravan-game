/**
 * Chunk 32: the client's telemetry — screen flow and crash reports, nothing else. No
 * third-party SDK, no storage of any kind (the queue lives in memory and dies with the page),
 * and no free text: a screen is a route name, a crash is a closed error class plus an 8-hex
 * hash of the error's first stack frames (never its message, which could carry anything).
 *
 * The server keys what it keeps by an opaque analytics id the client never sees, and honours
 * the account's opt-out itself: an opted-out batch is dropped and answered `optedOut: true`,
 * after which this reporter stops sending until the setting is turned back on.
 *
 * Batching: events queue and are flushed a few seconds after the first one (one request per
 * burst), at most TELEMETRY_BATCH_MAX per request; a failed send is dropped, never retried in
 * a loop. Telemetry must never break or slow the game.
 */
import type { TelemetryEvent, TelemetryIngestResult } from "../api/telemetryTypes.ts";
import { TELEMETRY_ERROR_NAMES, type TelemetryErrorName, type TelemetryScreen } from "./screens.ts";

export interface TelemetrySink {
  sendTelemetry(events: readonly TelemetryEvent[]): Promise<TelemetryIngestResult>;
}

/** Matches the server's TELEMETRY_MAX_EVENTS_PER_BATCH and TELEMETRY_MAX_AGO_MS. */
export const TELEMETRY_BATCH_MAX = 25;
export const TELEMETRY_MAX_AGO_MS = 3_600_000;
export const TELEMETRY_FLUSH_DELAY_MS = 5000;
/** Most events held while waiting to flush; older ones are dropped first. */
export const TELEMETRY_QUEUE_MAX = 100;

/** FNV-1a 32-bit, as 8 lowercase hex digits. */
export function fnv1a32Hex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function errorClass(error: unknown): TelemetryErrorName {
  if (error instanceof Error) {
    const name = error.name;
    if ((TELEMETRY_ERROR_NAMES as readonly string[]).includes(name)) return name as TelemetryErrorName;
    return "Error";
  }
  return "Unknown";
}

/**
 * A grouping key for a crash: the error class and its first three stack frames with every URL
 * and line/column stripped down to the function names, hashed. Two reports of the same bug
 * share a hash; nothing readable leaves the device.
 */
export function stackHash(error: unknown): string {
  const name = errorClass(error);
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const frames = stack
    .split("\n")
    .slice(1)
    .map((l) => l.replace(/\(?[a-z]+:\/\/[^\s)]*\)?/gi, "").replace(/[@:\d\s]+$/g, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);
  return fnv1a32Hex(`${name}|${frames.join("|")}`);
}

interface Queued {
  readonly event: TelemetryEvent;
  readonly at: number;
}

export interface ReporterOptions {
  readonly now?: () => number;
  readonly flushDelayMs?: number;
}

export class TelemetryReporter {
  private queue: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastScreen: TelemetryScreen | null = null;
  private stopped = false;
  private optedOut = false;
  private readonly now: () => number;
  private readonly flushDelayMs: number;

  constructor(
    private readonly sink: TelemetrySink,
    opts: ReporterOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.flushDelayMs = opts.flushDelayMs ?? TELEMETRY_FLUSH_DELAY_MS;
  }

  get isOptedOut(): boolean {
    return this.optedOut;
  }

  /** A screen became current. Repeats of the same screen are not events. */
  screen(screen: TelemetryScreen): void {
    if (screen === this.lastScreen) return;
    this.lastScreen = screen;
    this.push({ kind: "screen", screen, agoMs: 0 });
  }

  crash(error: unknown): void {
    this.push({ kind: "crash", screen: this.lastScreen ?? "town", errorName: errorClass(error), stackHash: stackHash(error), agoMs: 0 });
  }

  setOptedOut(optedOut: boolean): void {
    this.optedOut = optedOut;
    if (optedOut) this.clear();
  }

  /** Send what is queued now (one batch). Safe to call at any time; never throws. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped || this.optedOut || this.queue.length === 0) return;
    const now = this.now();
    const fresh = this.queue.filter((q) => now - q.at <= TELEMETRY_MAX_AGO_MS);
    const batch = fresh.slice(0, TELEMETRY_BATCH_MAX);
    this.queue = fresh.slice(TELEMETRY_BATCH_MAX);
    if (this.queue.length > 0) this.schedule();
    if (batch.length === 0) return;
    try {
      const res = await this.sink.sendTelemetry(batch.map((q) => ({ ...q.event, agoMs: Math.max(0, Math.min(TELEMETRY_MAX_AGO_MS, now - q.at)) })));
      if (res.optedOut) this.setOptedOut(true);
    } catch {
      // Dropped. Telemetry never retries in a loop and never surfaces an error to the player.
    }
  }

  /** Stop for good (sign-out): nothing more is sent. */
  dispose(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    this.queue = [];
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private push(event: TelemetryEvent): void {
    if (this.stopped || this.optedOut) return;
    this.queue.push({ event, at: this.now() });
    if (this.queue.length > TELEMETRY_QUEUE_MAX) this.queue.splice(0, this.queue.length - TELEMETRY_QUEUE_MAX);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
  }
}

// ── the signed-in session's reporter (one at a time) ─────────────────────────────────

let current: TelemetryReporter | null = null;

export function setCurrentReporter(reporter: TelemetryReporter | null): void {
  current = reporter;
}

/** For the render error boundary and the window error listeners. */
export function reportCrash(error: unknown): void {
  current?.crash(error);
}

/** The opt-out toggle tells the live reporter at once (the server enforces it regardless). */
export function setTelemetryOptOut(optedOut: boolean): void {
  current?.setOptedOut(optedOut);
}
