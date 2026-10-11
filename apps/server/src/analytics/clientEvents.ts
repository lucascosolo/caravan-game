/**
 * Chunk 32: client telemetry — screen flow and crash reports only (PHASE-2 §32).
 *
 * Privacy, by construction:
 *   - stored under the account's opaque `analytics_id` (random, migration 020), never the
 *     account id; the client never sees either;
 *   - every field is from a closed vocabulary (screen names, crash classes) or a fixed-shape
 *     token (an 8-hex stack hash). An unknown key or value refuses the whole batch, so no
 *     username, id or free text can slip into a row;
 *   - opt-out is a server-side account setting: an opted-out account's batches are accepted
 *     and dropped (nothing stored), and opting out deletes what was already kept;
 *   - rows cascade with the account (chunk 30's deletion has nothing to chase).
 *
 * Bounded cost: a body cap (route bodyLimit), a batch cap, a per-account in-process rate
 * window and a rolling 24 h per-id row cap. Times are the server's receipt time minus an age
 * clamped to the client's flush window, and a replayed batch is de-duplicated (QA D2).
 *
 * Nothing in play reads any of this (determinism / no pay-to-win): the resolver, matchmaking,
 * economy, acquisition and trip loop never import src/analytics (a test greps for it).
 */
import type pg from "pg";
import { withTransaction, type Queryable } from "../db/pool.js";
import { badRequest } from "../services/errors.js";
import {
  TELEMETRY_BATCHES_PER_WINDOW,
  TELEMETRY_DAILY_EVENT_CAP,
  TELEMETRY_ERROR_NAMES,
  TELEMETRY_LIMITER_MAX_KEYS,
  TELEMETRY_FLUSH_WINDOW_MS,
  TELEMETRY_MAX_EVENTS_PER_BATCH,
  TELEMETRY_RATE_WINDOW_MS,
  TELEMETRY_SCREENS,
  type TelemetryErrorName,
  type TelemetryScreen,
} from "./tunables.js";

/**
 * `heartbeat` (chunk 32 QA D2): sent about once a minute while the page is visible, so a long
 * stay on one screen reads as the session it is. Same closed shape as `screen`.
 */
export type ClientEvent =
  | { kind: "screen" | "heartbeat"; screen: TelemetryScreen; agoMs: number }
  | { kind: "crash"; screen: TelemetryScreen; errorName: TelemetryErrorName; stackHash: string; agoMs: number };

/**
 * A batch (QA D2): the client's per-page-session id (a random positive int31, regenerated on
 * every page load, never stored) and the batch's sequence number in that session. The server
 * de-duplicates on (analytics id, session, seq, event index): a replayed POST stores nothing.
 */
export interface ClientBatch {
  session: number;
  seq: number;
  events: ClientEvent[];
}

const INT31_MAX = 2_147_483_647;

const STACK_HASH = /^[0-9a-f]{8}$/;

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/**
 * Validate an ingest body. Throws 400 on anything outside the closed shape. `agoMs` is CLAMPED
 * to the flush window (QA D2): the client never holds an event longer, so a larger age cannot
 * back-date history — times are the server's receipt time minus at most that window.
 */
export function parseBatch(body: unknown): ClientBatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw badRequest("invalid_telemetry", "body must be an object { session, seq, events }");
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "events,seq,session") throw badRequest("invalid_telemetry", "body takes exactly: session, seq, events");
  const b = body as { session: unknown; seq: unknown; events: unknown };
  const int = (v: unknown, min: number): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= INT31_MAX;
  if (!int(b.session, 1)) throw badRequest("invalid_telemetry", "session must be an integer 1..2^31-1");
  if (!int(b.seq, 0)) throw badRequest("invalid_telemetry", "seq must be an integer 0..2^31-1");
  const events = b.events;
  if (!Array.isArray(events) || events.length < 1 || events.length > TELEMETRY_MAX_EVENTS_PER_BATCH) {
    throw badRequest("invalid_telemetry", `events must be an array of 1..${TELEMETRY_MAX_EVENTS_PER_BATCH}`);
  }
  const parsed = events.map((e, i): ClientEvent => {
    const fail = (why: string): never => {
      throw badRequest("invalid_telemetry", `events[${i}]: ${why}`);
    };
    if (typeof e !== "object" || e === null || Array.isArray(e)) return fail("must be an object");
    const r = e as Record<string, unknown>;
    const agoRaw = r["agoMs"] ?? 0;
    if (typeof agoRaw !== "number" || !Number.isSafeInteger(agoRaw) || agoRaw < 0) fail("agoMs must be a non-negative integer");
    const agoMs = Math.min(agoRaw as number, TELEMETRY_FLUSH_WINDOW_MS);
    if (!isOneOf(TELEMETRY_SCREENS, r["screen"])) fail("screen is not a known screen");
    const screen = r["screen"] as TelemetryScreen;
    if (r["kind"] === "screen" || r["kind"] === "heartbeat") {
      for (const k of Object.keys(r)) if (!["kind", "screen", "agoMs"].includes(k)) fail(`unknown key ${JSON.stringify(k.slice(0, 24))}`);
      return { kind: r["kind"], screen, agoMs };
    }
    if (r["kind"] === "crash") {
      for (const k of Object.keys(r)) if (!["kind", "screen", "agoMs", "errorName", "stackHash"].includes(k)) fail(`unknown key ${JSON.stringify(k.slice(0, 24))}`);
      if (!isOneOf(TELEMETRY_ERROR_NAMES, r["errorName"])) fail("errorName is not a known class");
      if (typeof r["stackHash"] !== "string" || !STACK_HASH.test(r["stackHash"])) fail("stackHash must be 8 lowercase hex digits");
      return { kind: "crash", screen, errorName: r["errorName"] as TelemetryErrorName, stackHash: r["stackHash"] as string, agoMs };
    }
    return fail("kind must be screen, heartbeat or crash");
  });
  return { session: b.session as number, seq: b.seq as number, events: parsed };
}

// ── rate limit (in-process fixed window per account) ─────────────────────────────────

export class TelemetryRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly perWindow: number = TELEMETRY_BATCHES_PER_WINDOW,
    private readonly windowMs: number = TELEMETRY_RATE_WINDOW_MS,
    private readonly maxKeys: number = TELEMETRY_LIMITER_MAX_KEYS,
  ) {}

  /** True if this batch may proceed; counts it. Returns the ms until the window resets otherwise. */
  take(key: string, nowMs: number): { ok: true } | { ok: false; retryAfterMs: number } {
    let w = this.windows.get(key);
    if (!w || nowMs - w.start >= this.windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.sweep(nowMs);
      w = { start: nowMs, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= this.perWindow) return { ok: false, retryAfterMs: w.start + this.windowMs - nowMs };
    w.count++;
    return { ok: true };
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(nowMs: number): void {
    for (const [k, w] of this.windows) if (nowMs - w.start >= this.windowMs) this.windows.delete(k);
    // Still full of live windows: drop the oldest (bounded memory beats a perfect count).
    while (this.windows.size >= this.maxKeys) {
      const first = this.windows.keys().next();
      if (first.done) break;
      this.windows.delete(first.value);
    }
  }
}

// ── the account's analytics row ──────────────────────────────────────────────────────

export interface AnalyticsSettingsRow {
  analytics_id: string;
  opted_out: boolean;
}

/** The account's analytics row, created on first use (opted in, a fresh random id). */
export async function ensureAnalyticsRow(db: Queryable, accountId: string): Promise<AnalyticsSettingsRow> {
  await db.query("INSERT INTO account_analytics (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING", [accountId]);
  const res = await db.query<AnalyticsSettingsRow>("SELECT analytics_id, opted_out FROM account_analytics WHERE account_id = $1", [accountId]);
  return res.rows[0]!;
}

/** What GET /me/analytics answers: only the setting. The opaque id is never sent to anyone. */
export interface AnalyticsSettingsView {
  optedOut: boolean;
}

export async function readSettings(db: Queryable, accountId: string): Promise<AnalyticsSettingsView> {
  const res = await db.query<{ opted_out: boolean }>("SELECT opted_out FROM account_analytics WHERE account_id = $1", [accountId]);
  return { optedOut: res.rows[0]?.opted_out ?? false };
}

/** Lock the account's analytics row (creating it first): ingest and the opt-out save serialize on it (QA S2). */
async function lockAnalyticsRow(client: pg.PoolClient, accountId: string): Promise<AnalyticsSettingsRow> {
  await client.query("INSERT INTO account_analytics (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING", [accountId]);
  return (await client.query<AnalyticsSettingsRow>("SELECT analytics_id, opted_out FROM account_analytics WHERE account_id = $1 FOR UPDATE", [accountId])).rows[0]!;
}

/**
 * PUT /me/analytics { optedOut }. Opting out also deletes the client events already kept. One
 * transaction holding the analytics row's lock (QA S2): a batch in flight either committed
 * before (and is deleted here) or runs after (and sees opted_out) — never in between.
 */
export async function saveSettings(db: pg.Pool, accountId: string, body: unknown): Promise<AnalyticsSettingsView> {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { optedOut?: unknown }).optedOut !== "boolean") {
    throw badRequest("invalid_analytics_settings", "body must be { optedOut: boolean }");
  }
  const optedOut = (body as { optedOut: boolean }).optedOut;
  return withTransaction(db, async (client) => {
    const row = await lockAnalyticsRow(client, accountId);
    await client.query("UPDATE account_analytics SET opted_out = $2 WHERE account_id = $1", [accountId, optedOut]);
    if (optedOut) await client.query("DELETE FROM analytics_client_event WHERE analytics_id = $1", [row.analytics_id]);
    return { optedOut };
  });
}

export interface IngestResult {
  accepted: number;
  dropped: number;
  optedOut: boolean;
}

/**
 * Store a validated batch under the account's analytics id — or drop it when opted out, over
 * the daily cap, or already stored (a replayed session/seq). One transaction holding the
 * analytics row's lock, the same lock the opt-out takes (QA S2).
 */
export async function ingest(db: pg.Pool, accountId: string, batch: ClientBatch, nowMs: number): Promise<IngestResult> {
  const events = batch.events;
  return withTransaction(db, async (client) => {
    const row = await lockAnalyticsRow(client, accountId);
    if (row.opted_out) return { accepted: 0, dropped: events.length, optedOut: true };
    const since = new Date(nowMs - 86_400_000);
    const used = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM analytics_client_event WHERE analytics_id = $1 AND occurred_at >= $2", [row.analytics_id, since])).rows[0]!.n;
    const room = Math.max(0, TELEMETRY_DAILY_EVENT_CAP - used);
    const kept = events.slice(0, room);
    let accepted = 0;
    if (kept.length > 0) {
      const now = new Date(nowMs);
      const res = await client.query(
        `INSERT INTO analytics_client_event (analytics_id, kind, screen, error_name, stack_hash, occurred_at, received_at, client_session, client_seq, client_idx)
         SELECT $1, e.kind, e.screen, e.error_name, e.stack_hash, $2::timestamptz - (e.ago_ms * interval '1 millisecond'), $2::timestamptz, $4, $5, e.idx
           FROM jsonb_to_recordset($3::jsonb) AS e(kind text, screen text, error_name text, stack_hash text, ago_ms bigint, idx smallint)
         ON CONFLICT (analytics_id, client_session, client_seq, client_idx) DO NOTHING`,
        [
          row.analytics_id,
          now,
          JSON.stringify(kept.map((e, idx) => ({ kind: e.kind, screen: e.screen, error_name: e.kind === "crash" ? e.errorName : null, stack_hash: e.kind === "crash" ? e.stackHash : null, ago_ms: e.agoMs, idx }))),
          batch.session,
          batch.seq,
        ],
      );
      accepted = res.rowCount ?? 0;
    }
    return { accepted, dropped: events.length - accepted, optedOut: false };
  });
}

/** Chunk 32 QA D5: the account's own analytics data for the account export (no analytics id). */
export async function analyticsForExport(db: Queryable, accountId: string): Promise<{ optedOut: boolean; events: { kind: string; screen: string; errorName: string | null; stackHash: string | null; occurredAt: string }[] }> {
  const settings = await readSettings(db, accountId);
  const res = await db.query<{ kind: string; screen: string; error_name: string | null; stack_hash: string | null; occurred_at: Date }>(
    `SELECT ce.kind, ce.screen, ce.error_name, ce.stack_hash, ce.occurred_at
       FROM account_analytics x JOIN analytics_client_event ce ON ce.analytics_id = x.analytics_id
      WHERE x.account_id = $1 ORDER BY ce.occurred_at, ce.id`,
    [accountId],
  );
  return { optedOut: settings.optedOut, events: res.rows.map((r) => ({ kind: r.kind, screen: r.screen, errorName: r.error_name, stackHash: r.stack_hash, occurredAt: r.occurred_at.toISOString() })) };
}
