/**
 * The projection fold in application code, independent of the SQL trigger that maintains
 * the live columns. Rebuilding from zero must produce exactly what the live columns hold;
 * if the two ever disagree, one of them has a bug and the ledger is the tie-breaker.
 *
 * "Zero" means: Coin 0, every progress row at REPUTATION_START with no ladder/points, and
 * no snapshot. Registration does not write events (chunk 01 predates the ledger), so the
 * initial row values are constants, not events. Chunk 04 may choose to emit an initial
 * reputation event instead; this fold would then start from 0 for that pool.
 */
import { TUNABLES } from "@caravan/content";
import type pg from "pg";
import { withTransaction, type Queryable } from "../db/pool.js";
import type { Pool } from "../db/types.js";
import { COIN_CREDIT_TYPES, COIN_DEBIT_TYPES, canonicalJson, type Json, type LedgerEventRow } from "./events.js";
import { lockAccountForAppend } from "./ledger.js";
import { LEDGER_SNAPSHOT_INTERVAL } from "../jobs/tunables.js";

export interface PoolProjection {
  reputation: number;
  ladderLevel: number;
  ladderPoints: number;
  unlockPointsGranted: number;
  unlockPointsSpent: number;
}

/** Everything this chunk projects for one account. Keys are stable for JSON comparison. */
export interface AccountProjection {
  coinBalance: number;
  /** Account-level pools: trap and siege. */
  accountPools: Record<"trap" | "siege", PoolProjection>;
  /** Caravan-level living pool, keyed by caravan id. */
  caravanPools: Record<string, PoolProjection>;
}

export function zeroPool(): PoolProjection {
  return {
    reputation: TUNABLES.REPUTATION_START,
    ladderLevel: 0,
    ladderPoints: 0,
    unlockPointsGranted: 0,
    unlockPointsSpent: 0,
  };
}

export function zeroProjection(caravanIds: readonly string[]): AccountProjection {
  const caravanPools: Record<string, PoolProjection> = {};
  for (const id of [...caravanIds].sort()) caravanPools[id] = zeroPool();
  return { coinBalance: 0, accountPools: { trap: zeroPool(), siege: zeroPool() }, caravanPools };
}

function int(v: Json | undefined, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new TypeError(`payload.${name} must be an integer, got ${String(v)}`);
  return v;
}

function poolOf(state: AccountProjection, ev: LedgerEventRow): PoolProjection {
  const pool = ev.payload["pool"] as Pool;
  if (pool === "living") {
    const id = ev.caravan_id;
    if (!id) throw new TypeError(`living-pool event ${ev.seq} has no caravan id`);
    const p = state.caravanPools[id] ?? (state.caravanPools[id] = zeroPool());
    return p;
  }
  if (pool === "trap" || pool === "siege") return state.accountPools[pool];
  throw new TypeError(`event ${ev.seq}: unknown pool '${String(pool)}'`);
}

/** Apply one event to a projection, in place. Mirrors ledger_event_project() in SQL. */
export function applyEvent(state: AccountProjection, ev: LedgerEventRow): AccountProjection {
  if (COIN_CREDIT_TYPES.has(ev.event_type)) state.coinBalance += int(ev.payload["amount"], "amount");
  else if (COIN_DEBIT_TYPES.has(ev.event_type)) state.coinBalance -= int(ev.payload["amount"], "amount");
  else if (ev.event_type === "reputation_changed") poolOf(state, ev).reputation += int(ev.payload["delta"], "delta");
  else if (ev.event_type === "ladder_progress_gained") {
    const p = poolOf(state, ev);
    p.ladderPoints += int(ev.payload["pointsDelta"], "pointsDelta");
    p.ladderLevel += int(ev.payload["levelsGained"], "levelsGained");
  } else if (ev.event_type === "unlock_points_granted") poolOf(state, ev).unlockPointsGranted += int(ev.payload["points"], "points");
  else if (ev.event_type === "unlock_node_purchased") poolOf(state, ev).unlockPointsSpent += int(ev.payload["cost"], "cost");
  return state;
}

export function foldEvents(state: AccountProjection, events: Iterable<LedgerEventRow>): AccountProjection {
  for (const ev of events) applyEvent(state, ev);
  return state;
}

async function caravanIdsOf(db: Queryable, accountId: string): Promise<string[]> {
  const res = await db.query<{ id: string }>("SELECT id FROM caravan WHERE account_id = $1 ORDER BY id", [accountId]);
  return res.rows.map((r) => r.id);
}

/** Read the live columns into the same shape, for comparison. */
export async function readLiveProjection(db: Queryable, accountId: string): Promise<AccountProjection> {
  const acct = await db.query<{ coin_balance: number }>("SELECT coin_balance FROM account WHERE id = $1", [accountId]);
  if (!acct.rows[0]) throw new Error(`account ${accountId} not found`);
  const state = zeroProjection(await caravanIdsOf(db, accountId));
  state.coinBalance = acct.rows[0].coin_balance;
  const rows = await db.query<{
    pool: Pool;
    caravan_id: string | null;
    reputation: number;
    ladder_level: number;
    ladder_points: number;
    unlock_points_granted: number;
    unlock_points_spent: number;
  }>(
    `SELECT pp.pool, pp.caravan_id, pp.reputation, pp.ladder_level, pp.ladder_points,
            pp.unlock_points_granted, pp.unlock_points_spent
     FROM pool_progress pp LEFT JOIN caravan c ON c.id = pp.caravan_id
     WHERE pp.account_id = $1 OR c.account_id = $1`,
    [accountId],
  );
  for (const r of rows.rows) {
    const p: PoolProjection = {
      reputation: r.reputation,
      ladderLevel: r.ladder_level,
      ladderPoints: r.ladder_points,
      unlockPointsGranted: r.unlock_points_granted,
      unlockPointsSpent: r.unlock_points_spent,
    };
    if (r.pool === "living") state.caravanPools[r.caravan_id!] = p;
    else state.accountPools[r.pool] = p;
  }
  return state;
}

export interface RebuildOptions {
  /** Start from the latest snapshot instead of zero (default: from zero). */
  fromSnapshot?: boolean;
  /** Fold only events with seq <= this (default: everything committed). */
  throughSeq?: number;
}

export interface RebuildResult {
  state: AccountProjection;
  /** seq of the last event folded (0 if none). */
  throughSeq: number;
  eventsFolded: number;
  startedFromSnapshot: number | null;
}

/** Replay the account's log and return the resulting state. Read-only. */
export async function rebuildProjection(
  db: Queryable,
  accountId: string,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  let state = zeroProjection(await caravanIdsOf(db, accountId));
  let fromSeq = 0;
  let startedFromSnapshot: number | null = null;
  if (opts.fromSnapshot) {
    const snap = await db.query<{ through_seq: number; state: AccountProjection }>(
      `SELECT through_seq, state FROM ledger_snapshot WHERE account_id = $1 AND through_seq <= $2
       ORDER BY through_seq DESC LIMIT 1`,
      [accountId, opts.throughSeq ?? Number.MAX_SAFE_INTEGER],
    );
    const row = snap.rows[0];
    if (row) {
      // Merge so caravans created after the snapshot still get their zero row.
      state = { ...state, ...row.state, caravanPools: { ...state.caravanPools, ...row.state.caravanPools } };
      fromSeq = row.through_seq;
      startedFromSnapshot = row.through_seq;
    }
  }
  const events = await db.query<LedgerEventRow>(
    `SELECT * FROM ledger_event WHERE account_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq`,
    [accountId, fromSeq, opts.throughSeq ?? Number.MAX_SAFE_INTEGER],
  );
  foldEvents(state, events.rows);
  const last = events.rows.at(-1);
  return { state, throughSeq: last ? last.seq : fromSeq, eventsFolded: events.rows.length, startedFromSnapshot };
}

/** Canonical string form of a projection (key order independent) for equality checks. */
export function projectionKey(state: AccountProjection): string {
  return canonicalJson(state as unknown as Json);
}

export interface VerifyResult {
  ok: boolean;
  live: AccountProjection;
  rebuilt: AccountProjection;
  eventsFolded: number;
}

/**
 * Rebuild from zero and compare with the live columns. Taken under the account's append
 * lock so no event lands between the two reads.
 */
export async function verifyProjection(pool: pg.Pool, accountId: string): Promise<VerifyResult> {
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, accountId);
    const live = await readLiveProjection(client, accountId);
    const { state: rebuilt, eventsFolded } = await rebuildProjection(client, accountId);
    return { ok: projectionKey(live) === projectionKey(rebuilt), live, rebuilt, eventsFolded };
  });
}

/**
 * Write a checkpoint if at least LEDGER_SNAPSHOT_INTERVAL events have landed since the
 * last one. Under the account lock, so `through_seq` is exact. Returns the seq written.
 */
export async function maybeSnapshot(
  pool: pg.Pool,
  accountId: string,
  interval: number = LEDGER_SNAPSHOT_INTERVAL,
): Promise<number | null> {
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, accountId);
    const last = await client.query<{ through_seq: number | null }>(
      "SELECT max(through_seq) AS through_seq FROM ledger_snapshot WHERE account_id = $1",
      [accountId],
    );
    const lastSeq = last.rows[0]?.through_seq ?? 0;
    const since = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ledger_event WHERE account_id = $1 AND seq > $2",
      [accountId, lastSeq],
    );
    if (Number(since.rows[0]!.n) < interval) return null;
    const rebuilt = await rebuildProjection(client, accountId, { fromSnapshot: true });
    if (rebuilt.throughSeq <= lastSeq) return null;
    await client.query(
      "INSERT INTO ledger_snapshot (account_id, through_seq, state) VALUES ($1, $2, $3::jsonb)",
      [accountId, rebuilt.throughSeq, JSON.stringify(rebuilt.state)],
    );
    return rebuilt.throughSeq;
  });
}
