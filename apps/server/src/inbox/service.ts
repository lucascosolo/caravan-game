/**
 * The in-app inbox (chunk 29, PHASE-2 §29): "close the asynchronous loop". The passive side's
 * whole feedback is "check afterward where it struck"; this is what tells the owner to check.
 *
 * DERIVED, never stored. Every item is computed on read from what already exists:
 *
 *   party_strike       the ledger: `party_served_as_encounter` on the owner's account and the
 *                      owner-side events the same resolution wrote (the results feed's join,
 *                      chunk 09), batched per INBOX_STRIKE_BATCH_WINDOW_MS window with a count
 *   refugees_arrived   the refugee drip's stored grid (chunk 18): a free menu is owed
 *   trip_cap_refilled  the trip cap's stored timestamp (chunk 15): every use is back
 *   mine_near_cap      the trickle (chunk 16, read-only peek): the balance is near the storage
 *                      cap, where the trickle stops
 *   packs_rotated      the weekly rotation (chunk 20): a new week began
 *   party_changed      the ledger: `standing_party_repaired` (final play-test review S2) — a
 *                      merge or a trip loss changed the standing party, or left it empty
 *
 * so a notification can never disagree with the ledger or the timers it reports. The only
 * stored state is what the player has READ and which categories they want (migration 015) —
 * UI state, deliberately not ledger events. Nothing here writes to the ledger, materializes
 * the trickle, bootstraps or takes a refugee menu, or touches a trip.
 *
 * What a strike reveals about the caravan it struck is exactly what the results feed already
 * shows — the defender's public username, caravan name and region — and never an account id
 * (§29: "must not leak the attacked player's identity beyond what the results feed shows").
 *
 * Nothing here is a Coin sink, sells a timer or links to a purchase (§29; GUARDRAILS §2).
 */
import { weekBounds, weekIndexAt } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import { REFUGEE_REFRESH_INTERVAL_MS } from "../acquisition/refugeeMenu.js";
import { peekTrickle } from "../economy/trickle.js";
import { COIN_CREDIT_TYPES, COIN_DEBIT_TYPES } from "../ledger/events.js";
import type { LedgerEventRow } from "../ledger/events.js";
import { partyFeedEntries } from "../party/feed.js";
import { badRequest } from "../services/errors.js";
import { TRIPS_PER_HOUR_CAP, readTripCapTat } from "../trip/cap.js";
import {
  finishItems,
  horizonStartMs,
  windowLines,
  mineItem,
  packsItem,
  partyChangedItem,
  refugeeItem,
  strikeItem,
  tripCapItem,
  type DraftItem,
  type InboxItem,
  type InboxStrike,
  type StrikeWindowTotals,
} from "./derive.js";
import {
  INBOX_CATEGORIES,
  INBOX_CATEGORY_DEFAULTS,
  INBOX_HORIZON_MS,
  INBOX_ITEMIZED_BATCHES,
  INBOX_MAX_MARKS_PER_REQUEST,
  INBOX_MAX_PARTY_CHANGE_ITEMS,
  INBOX_MAX_STRIKE_ITEMS,
  INBOX_MINE_NEAR_CAP_PERCENT,
  INBOX_STRIKES_PER_ITEM,
  INBOX_STRIKE_BATCH_WINDOW_MS,
  type InboxCategory,
} from "./tunables.js";

export interface InboxPreferenceView {
  category: InboxCategory;
  enabled: boolean;
  /** The default (§29 as amended by the final play-test review D7): on for party strikes, party changes, refugees and the trip cap. */
  defaultEnabled: boolean;
}

export interface InboxView {
  /** Newest first. Only categories the player has on. */
  items: InboxItem[];
  unreadCount: number;
  preferences: InboxPreferenceView[];
  /** Strike batches this read does not list (past the 30th, or older than the horizon), or null when there are none (QA D2). The results feed has them all. */
  olderStrikes: OlderStrikes | null;
  strikeBatchWindowMs: number;
  horizonMs: number;
  /** There is no device push yet (PWA / chunk 34): the inbox is the delivery and the record. */
  delivery: "in_app";
}

export interface UnreadView {
  unreadCount: number;
}

const isCategory = (v: unknown): v is InboxCategory => typeof v === "string" && (INBOX_CATEGORIES as readonly string[]).includes(v);

export async function readPreferences(db: Queryable, accountId: string): Promise<InboxPreferenceView[]> {
  const rows = await db.query<{ category: string; enabled: boolean }>("SELECT category, enabled FROM inbox_preference WHERE account_id = $1", [accountId]);
  const stored = new Map(rows.rows.map((r) => [r.category, r.enabled]));
  return INBOX_CATEGORIES.map((category) => ({
    category,
    enabled: stored.get(category) ?? INBOX_CATEGORY_DEFAULTS[category],
    defaultEnabled: INBOX_CATEGORY_DEFAULTS[category],
  }));
}

/** What the strike batches of one read left out, so the inbox can say so (QA D2). */
export interface OlderStrikes {
  /** Batches inside the horizon past the INBOX_MAX_STRIKE_ITEMS newest. */
  batchesPastLimit: number;
  /** Strikes older than the horizon exist. */
  beforeHorizon: boolean;
}

interface StrikeWindowsRead {
  windows: StrikeWindowTotals[];
  older: OlderStrikes;
}

const SERVED_SINCE = `
  SELECT s.seq, s.causation_id, s.occurred_at, s.payload->'outcome'->>'kind' AS kind,
         floor(extract(epoch FROM s.occurred_at) * 1000 / $3)::bigint AS win
  FROM ledger_event s
  WHERE s.account_id = $1 AND s.event_type = 'party_served_as_encounter' AND s.occurred_at >= to_timestamp($2 / 1000.0)`;

/**
 * Totals per strike window, over EVERY strike in it: SQL sums, so the count and the Coin are
 * exact however many strikes a window holds. One statement (QA S4): the windows are picked
 * first (newest INBOX_MAX_STRIKE_ITEMS, from the partial index of migration 018) and only
 * their strikes are joined to their owner-side events. The version is the newest seq among a
 * window's strikes AND those events (QA S2), so a settle that lands later re-opens the batch.
 * `sinceMs` is a window start (horizonStartMs), so no window is cut in half (QA N1).
 */
async function strikeWindows(db: Queryable, accountId: string, sinceMs: number): Promise<StrikeWindowsRead> {
  const res = await db.query<{
    total_wins: number;
    before_horizon: boolean;
    win: string | null;
    count: number;
    max_seq: string;
    newest_ms: string;
    held: number;
    overran: number;
    stalemate: number;
    coin: number;
    transferred: number;
    discarded: number;
    rep: number;
    ladder: number;
  }>(
    `WITH served AS (${SERVED_SINCE}),
     wins AS (SELECT win FROM served GROUP BY win ORDER BY win DESC LIMIT $4),
     totals AS (
       SELECT s.win,
              count(*)::int AS count,
              max(greatest(s.seq, coalesce(x.max_seq, 0)))::text AS max_seq,
              (floor(extract(epoch FROM max(s.occurred_at)) * 1000))::text AS newest_ms,
              (count(*) FILTER (WHERE s.kind = 'caravan_held'))::int AS held,
              (count(*) FILTER (WHERE s.kind = 'caravan_overrun'))::int AS overran,
              (count(*) FILTER (WHERE s.kind = 'stalemate'))::int AS stalemate,
              coalesce(sum(x.coin), 0)::int AS coin,
              coalesce(sum(x.transferred), 0)::int AS transferred,
              coalesce(sum(x.discarded), 0)::int AS discarded,
              coalesce(sum(x.rep), 0)::int AS rep,
              coalesce(sum(x.ladder), 0)::int AS ladder
       FROM served s
       JOIN wins w ON w.win = s.win
       LEFT JOIN LATERAL (
         -- The results feed's join (party/feed.ts): the owner-side events of ONE resolution live
         -- under its job id, progression:<job> and transfer:<job>.
         SELECT
           max(c.seq) AS max_seq,
           sum(CASE WHEN c.event_type IN ('coin_earned', 'coin_transferred_to_party_owner') THEN (c.payload->>'amount')::int ELSE 0 END) AS coin,
           sum(CASE WHEN c.event_type = 'coin_transferred_to_party_owner' THEN (c.payload->>'amount')::int ELSE 0 END) AS transferred,
           sum(CASE WHEN c.event_type IN ('coin_earned', 'coin_transferred_to_party_owner') THEN coalesce((c.payload->>'overflowDiscarded')::int, 0) ELSE 0 END) AS discarded,
           sum(CASE WHEN c.event_type = 'reputation_changed' AND c.payload->>'pool' = 'siege' THEN (c.payload->>'delta')::int ELSE 0 END) AS rep,
           sum(CASE WHEN c.event_type = 'ladder_progress_gained' AND c.payload->>'pool' = 'siege' THEN (c.payload->>'pointsDelta')::int ELSE 0 END) AS ladder
         FROM ledger_event c
         WHERE c.account_id = $1
           AND c.causation_id IN (s.causation_id, 'progression:' || s.causation_id, 'transfer:' || s.causation_id)
           AND c.event_type IN ('coin_earned', 'coin_transferred_to_party_owner', 'reputation_changed', 'ladder_progress_gained')
       ) x ON true
       GROUP BY s.win
     ),
     meta AS (
       SELECT (SELECT count(DISTINCT win) FROM served)::int AS total_wins,
              -- min() on the partial index (one index probe), not a scan of the account's older rows.
              (SELECT min(o.occurred_at) FROM ledger_event o
               WHERE o.account_id = $1 AND o.event_type = 'party_served_as_encounter' AND o.occurred_at < to_timestamp($2 / 1000.0)) IS NOT NULL AS before_horizon
     )
     SELECT meta.total_wins, meta.before_horizon, t.win::text AS win, t.count, t.max_seq, t.newest_ms, t.held, t.overran, t.stalemate,
            t.coin, t.transferred, t.discarded, t.rep, t.ladder
     FROM meta LEFT JOIN totals t ON true
     ORDER BY t.win DESC NULLS LAST`,
    [accountId, sinceMs, INBOX_STRIKE_BATCH_WINDOW_MS, INBOX_MAX_STRIKE_ITEMS],
  );
  const meta = res.rows[0];
  const windows = res.rows
    .filter((r) => r.win !== null)
    .map((r) => ({
      window: Number(r.win),
      count: r.count,
      maxSeq: Number(r.max_seq),
      newestAtMs: Number(r.newest_ms),
      held: r.held,
      overran: r.overran,
      stalemate: r.stalemate,
      coinEarned: r.coin,
      coinTransferred: r.transferred,
      coinDiscardedAtCap: r.discarded,
      reputationDelta: r.rep,
      ladderPointsGained: r.ladder,
    }));
  return {
    windows,
    older: { batchesPastLimit: Math.max(0, (meta?.total_wins ?? 0) - windows.length), beforeHorizon: meta?.before_horizon === true },
  };
}

/**
 * The listed strikes of the given windows: the newest INBOX_STRIKES_PER_ITEM of EACH window,
 * picked by time window in one query (never by a seq cursor: occurred_at is the transaction's
 * start, seq the commit order, and the two can interleave across a window edge — QA N5), and
 * built through the results feed itself (one source of truth for each line). Three queries in
 * all, however many windows.
 */
async function listedStrikes(db: Queryable, accountId: string, windows: readonly number[]): Promise<InboxStrike[]> {
  if (windows.length === 0) return [];
  const W = INBOX_STRIKE_BATCH_WINDOW_MS;
  // A range around the windows for the index, then the exact window by the same expression the totals use.
  const fromMs = Math.min(...windows) * W - 1;
  const toMs = (Math.max(...windows) + 1) * W + 1;
  const rows = await db.query<LedgerEventRow>(
    `SELECT * FROM (
       SELECT l.*, row_number() OVER (PARTITION BY floor(extract(epoch FROM l.occurred_at) * 1000 / $4)::bigint ORDER BY l.seq DESC) AS inbox_rank,
              floor(extract(epoch FROM l.occurred_at) * 1000 / $4)::bigint AS inbox_win
       FROM ledger_event l
       WHERE l.account_id = $1 AND l.event_type = 'party_served_as_encounter'
         AND l.occurred_at >= to_timestamp($2 / 1000.0) AND l.occurred_at < to_timestamp($3 / 1000.0)
     ) t
     WHERE t.inbox_rank <= $5 AND t.inbox_win = ANY($6::bigint[])
     ORDER BY t.seq DESC`,
    [accountId, fromMs, toMs, W, INBOX_STRIKES_PER_ITEM, [...windows]],
  );
  const entries = await partyFeedEntries(db, accountId, rows.rows);
  return entries.map((e) => ({
    seq: e.seq,
    occurredAt: e.occurredAt,
    jobId: e.jobId,
    encounterIndex: e.encounterIndex,
    outcomeKind: e.outcomeKind,
    // Picked field by field: the feed's caravan id and everything else stay out.
    defender: { username: e.defender.username, caravanName: e.defender.caravanName, regionId: e.defender.regionId },
    coinEarned: e.coinEarned,
    coinTransferred: e.coinTransferred,
    coinDiscardedAtCap: e.coinDiscardedAtCap,
    reputationDelta: e.reputationDelta,
    ladderPointsGained: e.ladderPointsGained,
  }));
}

export interface StrikeLinesView {
  window: number;
  strikes: InboxStrike[];
}

/** GET /me/inbox/strikes/:window — one batch's lines, for a batch the inbox read sent without them (QA S4). The caller's own ledger only. */
export async function readStrikeLines(db: Queryable, accountId: string, window: unknown): Promise<StrikeLinesView> {
  const w = typeof window === "string" && /^[0-9]{1,15}$/.test(window) ? Number(window) : NaN;
  if (!Number.isSafeInteger(w)) throw badRequest("invalid_request", "the window must be a non-negative integer");
  return { window: w, strikes: windowLines(w, await listedStrikes(db, accountId, [w])) };
}

async function mineDraft(db: Queryable, accountId: string, nowMs: number, accountCreatedMs: number): Promise<DraftItem | null> {
  const t = await peekTrickle(db, accountId, nowMs);
  if (t.balance < Math.floor((t.cap * INBOX_MINE_NEAR_CAP_PERCENT) / 100)) return null;
  const spend = await db.query<{ seq: string | null }>(
    "SELECT max(seq)::text AS seq FROM ledger_event WHERE account_id = $1 AND event_type::text = ANY($2::text[])",
    [accountId, [...COIN_DEBIT_TYPES]],
  );
  const lastSpendSeq = spend.rows[0]?.seq ? Number(spend.rows[0].seq) : 0;
  const credit = await db.query<{ ms: string | null }>(
    `SELECT (floor(extract(epoch FROM max(occurred_at)) * 1000))::text AS ms FROM ledger_event
     WHERE account_id = $1 AND seq > $2 AND event_type::text = ANY($3::text[])`,
    [accountId, lastSpendSeq, [...COIN_CREDIT_TYPES]],
  );
  const lastCreditMs = credit.rows[0]?.ms ? Number(credit.rows[0].ms) : accountCreatedMs;
  return mineItem(
    {
      balance: t.balance,
      ledgerBalance: t.ledgerBalance,
      cap: t.cap,
      accruedFromMs: t.accruedFromMs,
      nextCoinInMs: t.nextCoinInMs,
      msPerCoin: t.msPerCoin,
      ratePerHour: t.ratePerHour,
      lastSpendSeq,
      lastCreditMs,
    },
    nowMs,
  );
}

/** Every item the enabled categories produce right now, before the read marks. */
async function draftItems(
  db: Queryable,
  accountId: string,
  nowMs: number,
  enabled: ReadonlySet<InboxCategory>,
  withDetails: boolean,
): Promise<{ drafts: DraftItem[]; older: OlderStrikes | null }> {
  let createdMs: number | null = null;
  const accountCreatedMs = async (): Promise<number> => {
    if (createdMs === null) {
      const acct = await db.query<{ created_ms: string }>("SELECT (floor(extract(epoch FROM created_at) * 1000))::text AS created_ms FROM account WHERE id = $1", [accountId]);
      createdMs = Number(acct.rows[0]?.created_ms ?? 0);
    }
    return createdMs;
  };
  const drafts: DraftItem[] = [];
  let older: OlderStrikes | null = null;

  if (enabled.has("party_strike")) {
    const read = await strikeWindows(db, accountId, horizonStartMs(nowMs));
    const itemized = withDetails ? read.windows.slice(0, INBOX_ITEMIZED_BATCHES).map((t) => t.window) : [];
    const lines = await listedStrikes(db, accountId, itemized);
    for (const t of read.windows) drafts.push(strikeItem(t, itemized.includes(t.window) ? lines : null));
    older = read.older.batchesPastLimit > 0 || read.older.beforeHorizon ? read.older : null;
  }
  if (enabled.has("refugees_arrived")) {
    // Read-only: the CURRENT menu row of each caravan (never the GET that bootstraps one).
    const rows = await db.query<{ id: string; name: string; region_id: string; window_opened_at_ms: number | null; claimed: boolean | null }>(
      `SELECT c.id, c.name, c.region_id, m.window_opened_at_ms, (m.claimed_type_id IS NOT NULL) AS claimed
       FROM caravan c
       LEFT JOIN LATERAL (SELECT * FROM refugee_menu r WHERE r.caravan_id = c.id ORDER BY r.sequence DESC LIMIT 1) m ON true
       WHERE c.account_id = $1 ORDER BY c.created_at, c.id`,
      [accountId],
    );
    for (const r of rows.rows) {
      const menu = r.window_opened_at_ms === null ? null : { windowOpenedAtMs: Number(r.window_opened_at_ms), claimed: r.claimed === true };
      const item = refugeeItem({ id: r.id, name: r.name, regionId: r.region_id }, menu, REFUGEE_REFRESH_INTERVAL_MS, nowMs);
      if (item) drafts.push(item);
    }
  }
  if (enabled.has("trip_cap_refilled")) {
    const item = tripCapItem(await readTripCapTat(db, accountId), TRIPS_PER_HOUR_CAP, nowMs, INBOX_HORIZON_MS);
    if (item) drafts.push(item);
  }
  if (enabled.has("mine_near_cap")) {
    const item = await mineDraft(db, accountId, nowMs, await accountCreatedMs());
    if (item) drafts.push(item);
  }
  if (enabled.has("packs_rotated")) {
    const index = weekIndexAt(nowMs);
    const item = packsItem({ index, ...weekBounds(index) }, await accountCreatedMs());
    if (item) drafts.push(item);
  }
  if (enabled.has("party_changed")) {
    const rows = await db.query<{ seq: string; ms: string; payload: Record<string, unknown> }>(
      `SELECT seq::text AS seq, (floor(extract(epoch FROM occurred_at) * 1000))::text AS ms, payload FROM ledger_event
       WHERE account_id = $1 AND event_type = 'standing_party_repaired' AND occurred_at >= to_timestamp($2 / 1000.0)
       ORDER BY seq DESC LIMIT $3`,
      [accountId, nowMs - INBOX_HORIZON_MS, INBOX_MAX_PARTY_CHANGE_ITEMS],
    );
    for (const r of rows.rows) drafts.push(partyChangedItem({ seq: Number(r.seq), occurredAtMs: Number(r.ms), payload: r.payload }));
  }
  return { drafts, older };
}

async function readMarks(db: Queryable, accountId: string, keys: readonly string[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const res = await db.query<{ item_key: string; version: number }>("SELECT item_key, version FROM inbox_read WHERE account_id = $1 AND item_key = ANY($2::text[])", [
    accountId,
    keys,
  ]);
  return new Map(res.rows.map((r) => [r.item_key, Number(r.version)]));
}

async function build(
  db: Queryable,
  accountId: string,
  nowMs: number,
  withDetails: boolean,
): Promise<{ items: InboxItem[]; preferences: InboxPreferenceView[]; older: OlderStrikes | null }> {
  const preferences = await readPreferences(db, accountId);
  const enabled = new Set(preferences.filter((p) => p.enabled).map((p) => p.category));
  const { drafts, older } = await draftItems(db, accountId, nowMs, enabled, withDetails);
  const marks = await readMarks(
    db,
    accountId,
    drafts.map((d) => d.key),
  );
  return { items: finishItems(drafts, marks), preferences, older };
}

export async function readInbox(db: Queryable, accountId: string, nowMs: number): Promise<InboxView> {
  const { items, preferences, older } = await build(db, accountId, nowMs, true);
  return {
    items,
    unreadCount: items.filter((i) => i.unread).length,
    preferences,
    olderStrikes: older,
    strikeBatchWindowMs: INBOX_STRIKE_BATCH_WINDOW_MS,
    horizonMs: INBOX_HORIZON_MS,
    delivery: "in_app",
  };
}

/** The badge: the same derivation without the per-strike lines. */
export async function readUnread(db: Queryable, accountId: string, nowMs: number): Promise<UnreadView> {
  const { items } = await build(db, accountId, nowMs, false);
  return { unreadCount: items.filter((i) => i.unread).length };
}

export interface MarkRequest {
  /**
   * The key and the version the client SAW, for each item to mark ("Mark all read" sends every
   * unread item it is showing). A newer version stays unread. There is no "mark everything"
   * (QA S1): it would read strikes that landed after the client rendered.
   */
  marks: { key: string; version: number }[];
}

export interface MarkResult extends InboxView {
  /** Keys the inbox is no longer showing (a trip started, a menu was taken, a batch aged out): nothing was stored for them (QA N4). */
  ignored: string[];
}

/**
 * Store read marks. Only keys the account's inbox currently shows are stored — any other key is
 * skipped and reported in `ignored` (QA N4: a stale screen must not fail the whole request), so
 * a client still cannot write arbitrary rows — and the stored version is the LOWER of what the
 * client saw and what the item is now: a strike that landed after the client rendered stays
 * unread. One key sent twice counts once, at the higher of its versions (QA N2). Marks only
 * move forward (GREATEST here; UPDATE and DELETE triggers in the schema).
 */
export async function markRead(db: Queryable, accountId: string, body: unknown, nowMs: number): Promise<MarkResult> {
  const req = parseMarkRequest(body);
  const { items } = await build(db, accountId, nowMs, false);
  const current = new Map(items.map((i) => [i.key, i.version]));
  const folded = new Map<string, number>();
  const ignored: string[] = [];
  for (const m of req.marks) {
    const now = current.get(m.key);
    if (now === undefined) {
      if (!ignored.includes(m.key)) ignored.push(m.key);
      continue;
    }
    folded.set(m.key, Math.max(folded.get(m.key) ?? -1, Math.min(now, m.version)));
  }
  if (folded.size > 0) {
    await db.query(
      `INSERT INTO inbox_read (account_id, item_key, version)
       SELECT $1, k, v FROM unnest($2::text[], $3::bigint[]) AS t(k, v)
       ON CONFLICT (account_id, item_key) DO UPDATE SET version = GREATEST(inbox_read.version, EXCLUDED.version), read_at = now()`,
      [accountId, [...folded.keys()], [...folded.values()]],
    );
  }
  return { ...(await readInbox(db, accountId, nowMs)), ignored };
}

function parseMarkRequest(body: unknown): MarkRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw badRequest("invalid_request", "body must be an object: { marks: [{ key, version }] }");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "marks")) throw badRequest("invalid_request", "only `marks` may be sent: the key and version of each item you are showing");
  const marks = b["marks"];
  if (!Array.isArray(marks) || marks.length === 0) throw badRequest("invalid_request", "`marks` must be a non-empty array");
  if (marks.length > INBOX_MAX_MARKS_PER_REQUEST) throw badRequest("invalid_request", `at most ${INBOX_MAX_MARKS_PER_REQUEST} marks per request`);
  return {
    marks: marks.map((m, i) => {
      if (m === null || typeof m !== "object" || Array.isArray(m)) throw badRequest("invalid_request", `marks[${i}] must be { key, version }`);
      const o = m as Record<string, unknown>;
      if (Object.keys(o).some((k) => k !== "key" && k !== "version")) throw badRequest("invalid_request", `marks[${i}] may carry only key and version`);
      if (typeof o["key"] !== "string" || o["key"].length === 0 || o["key"].length > 200) throw badRequest("invalid_request", `marks[${i}].key must be a string`);
      const v = o["version"];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw badRequest("invalid_request", `marks[${i}].version must be a non-negative integer`);
      return { key: o["key"], version: v };
    }),
  };
}

/** PUT /me/inbox/preferences: `{ preferences: { <category>: boolean, ... } }`, partial. Free; changes nothing but what is listed. */
export async function savePreferences(db: Queryable, accountId: string, body: unknown, nowMs: number): Promise<InboxView> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw badRequest("invalid_request", "body must be { preferences: { <category>: boolean } }");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "preferences")) throw badRequest("invalid_request", "only `preferences` may be sent");
  const prefs = b["preferences"];
  if (prefs === null || typeof prefs !== "object" || Array.isArray(prefs) || Object.keys(prefs).length === 0) {
    throw badRequest("invalid_request", "`preferences` must be a non-empty object of category → boolean");
  }
  const entries = Object.entries(prefs as Record<string, unknown>);
  for (const [category, enabled] of entries) {
    if (!isCategory(category)) throw badRequest("unknown_category", `unknown inbox category ${JSON.stringify(category)}; known: ${INBOX_CATEGORIES.join(", ")}`);
    if (typeof enabled !== "boolean") throw badRequest("invalid_request", `preferences.${category} must be a boolean`);
  }
  await db.query(
    `INSERT INTO inbox_preference (account_id, category, enabled)
     SELECT $1, c, e FROM unnest($2::text[], $3::boolean[]) AS t(c, e)
     ON CONFLICT (account_id, category) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [accountId, entries.map(([c]) => c), entries.map(([, e]) => e)],
  );
  return readInbox(db, accountId, nowMs);
}

