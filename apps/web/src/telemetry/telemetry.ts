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
 * a loop. Telemetry must never break or slow the game. Each batch carries this page load's
 * random session id and a sequence number, so the server can de-duplicate a replay; the server
 * times events by receipt (an age is clamped to the flush window), and a heartbeat about once a
 * minute while the page is visible measures a long stay on one screen (QA D2). Nothing is sent
 * until the account's opt-out has been read from the server (QA N8).
 */
import type { AnalyticsSettings, TelemetryBatch, TelemetryEvent, TelemetryIngestResult } from "../api/telemetryTypes.ts";
import { TELEMETRY_ERROR_NAMES, type TelemetryErrorName, type TelemetryScreen } from "./screens.ts";

export interface TelemetrySink {
  sendTelemetry(batch: TelemetryBatch): Promise<TelemetryIngestResult>;
  /** QA N8: the account's setting, read before anything is sent. */
  analyticsSettings(): Promise<AnalyticsSettings>;
}

/** Matches the server's TELEMETRY_MAX_EVENTS_PER_BATCH and TELEMETRY_FLUSH_WINDOW_MS (QA D2). */
export const TELEMETRY_BATCH_MAX = 25;
export const TELEMETRY_MAX_AGO_MS = 15_000;
export const TELEMETRY_FLUSH_DELAY_MS = 5000;
/** QA D2: a heartbeat about once a minute while the page is visible (the server's TELEMETRY_HEARTBEAT_MS). */
export const TELEMETRY_HEARTBEAT_MS = 60_000;

/** A random positive int31 per page load (never stored): the batch envelope's session id (QA D2). */
export function newPageSession(): number {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return (a[0]! % 2_147_483_647) + 1;
}
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
  readonly session?: number;
}

export class TelemetryReporter {
  private queue: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastScreen: TelemetryScreen | null = null;
  private stopped = false;
  private optedOut = false;
  /** QA N8: nothing is sent until the account's setting has been read from the server. */
  private settingKnown = false;
  private settingRead: Promise<void> | null = null;
  private seq = 0;
  private readonly session: number;
  private readonly now: () => number;
  private readonly flushDelayMs: number;

  constructor(
    private readonly sink: TelemetrySink,
    opts: ReporterOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.flushDelayMs = opts.flushDelayMs ?? TELEMETRY_FLUSH_DELAY_MS;
    this.session = opts.session ?? newPageSession();
  }

  /** Read the opt-out from the server (QA N8). A failure leaves it unknown: the queue is held and the next flush asks again. */
  readSetting(): Promise<void> {
    if (this.settingKnown) return Promise.resolve();
    if (this.settingRead === null) {
      this.settingRead = (async () => {
        try {
          const s = await this.sink.analyticsSettings();
          this.settingKnown = true;
          this.setOptedOut(s.optedOut);
        } catch {
          // Unknown: hold; try again on the next flush.
        } finally {
          this.settingRead = null;
        }
      })();
    }
    return this.settingRead;
  }

  /** QA D2: "still here" — the current screen, sent about once a minute while the page is visible. */
  heartbeat(): void {
    if (this.lastScreen === null) return;
    this.push({ kind: "heartbeat", screen: this.lastScreen, agoMs: 0 });
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
    this.settingKnown = true;
    if (optedOut) this.clear();
  }

  /** Send what is queued now (one batch). Safe to call at any time; never throws. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped || this.optedOut || this.queue.length === 0) return;
    if (!this.settingKnown) {
      await this.readSetting();
      if (!this.settingKnown) {
        this.schedule();
        return;
      }
      if (this.stopped || this.optedOut) return;
    }
    const now = this.now();
    const fresh = this.queue.filter((q) => now - q.at <= TELEMETRY_MAX_AGO_MS);
    const batch = fresh.slice(0, TELEMETRY_BATCH_MAX);
    this.queue = fresh.slice(TELEMETRY_BATCH_MAX);
    if (this.queue.length > 0) this.schedule();
    if (batch.length === 0) return;
    try {
      const seq = this.seq++;
      const res = await this.sink.sendTelemetry({ session: this.session, seq, events: batch.map((q) => ({ ...q.event, agoMs: Math.max(0, Math.min(TELEMETRY_MAX_AGO_MS, now - q.at)) })) });
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
