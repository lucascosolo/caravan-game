/**
 * Append-only ledger: the write path and the read path. Nothing here updates or deletes;
 * the database refuses both anyway (migration 002).
 *
 * Appends for one account are serialized with a transaction-scoped advisory lock, so a
 * single account's events commit in seq order and two concurrent writers for the same
 * account (two trips, a purchase racing a bank) never interleave into a torn projection.
 */
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import {
  canonicalJson,
  type LedgerEventDraft,
  type LedgerEventRow,
  validateDraft,
} from "./events.js";

/** Advisory lock namespaces (first key of pg_advisory_xact_lock(int, int)). */
export const LOCK_NS_CARAVAN = 1;
export const LOCK_NS_ACCOUNT = 2;
/** PHASE-2 §36 (QA S1): one fight's log / summary, taken by compaction (try) and account erasure (wait) — in SQL only (migration 025). */
export const LOCK_NS_ENCOUNTER_LOG = 36;

/** Take the per-account append lock for the rest of the current transaction. */
export async function lockAccountForAppend(client: pg.PoolClient, accountId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK_NS_ACCOUNT, accountId]);
}

/**
 * Take the append locks for several accounts, in SORTED id order, for the rest of the
 * transaction. This is the one lock-ordering rule for the ledger (QA-02 S5): a transaction
 * that will touch several accounts takes all of their locks here, up front, before it reads
 * any balance or builds any draft. Two transactions that both do this can never deadlock,
 * whatever accounts they share. (Advisory xact locks are re-entrant, so appendEvents
 * re-taking them afterwards is harmless.)
 */
export async function lockAccountsForAppend(client: pg.PoolClient, accountIds: Iterable<string>): Promise<string[]> {
  const ids = [...new Set(accountIds)].sort();
  for (const id of ids) await lockAccountForAppend(client, id);
  return ids;
}

/**
 * Is this transaction already holding the append lock for `accountId`? Read from pg_locks
 * for the current backend: a two-key advisory xact lock shows up with classid = key1,
 * objid = key2 (as an unsigned 32-bit value) and objsubid = 2.
 */
export async function isAccountAppendLockHeld(client: pg.PoolClient, accountId: string): Promise<boolean> {
  const res = await client.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
         AND classid = $1 AND objsubid = 2
         AND objid::bigint = (hashtext($2)::bigint & 4294967295)
     ) AS held`,
    [LOCK_NS_ACCOUNT, accountId],
  );
  return res.rows[0]!.held;
}

/** Throw a readable error unless the append lock for `accountId` is held by this transaction. */
export async function assertAccountAppendLockHeld(client: pg.PoolClient, accountId: string, what: string): Promise<void> {
  if (!(await isAccountAppendLockHeld(client, accountId))) {
    throw new Error(
      `${what}: the append lock for account ${accountId} is not held. Take every account's lock first with lockAccountsForAppend(client, ids) (sorted order), then build drafts.`,
    );
  }
}

/** Take the per-caravan resolution lock (TRIP_LOCK_MODE) for the rest of the transaction. */
export async function lockCaravanForResolution(client: pg.PoolClient, caravanId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK_NS_CARAVAN, caravanId]);
}

/**
 * Append a batch of events under one causation id, inside the caller's transaction.
 * Events get causation_seq 0..n-1 in array order. Account locks are taken in sorted id
 * order (deadlock-free across concurrent batches — PROVIDED the caller took no account
 * lock out of order earlier in the transaction; see lockAccountsForAppend). A retried cause that already committed
 * hits the (causation_id, causation_seq) unique constraint and the whole batch fails —
 * callers that want "commit nothing new" semantics check for prior completion first (the
 * job worker does) and treat 23505 here as the backstop, never the primary mechanism.
 */
export async function appendEvents(
  client: pg.PoolClient,
  causationId: string,
  drafts: readonly LedgerEventDraft[],
): Promise<LedgerEventRow[]> {
  if (!causationId) throw new TypeError("causationId is required");
  for (const d of drafts) validateDraft(d);
  const accountIds = [...new Set(drafts.map((d) => d.accountId))].sort();
  for (const id of accountIds) await lockAccountForAppend(client, id);
  const rows: LedgerEventRow[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    const res = await client.query<LedgerEventRow>(
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, resolver_version, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
      [d.type, d.accountId, d.caravanId ?? null, causationId, i, d.resolverVersion ?? null, canonicalJson(d.payload)],
    );
    rows.push(res.rows[0]!);
  }
  return rows;
}

/** Has anything already been committed under this causation id? */
export async function causationExists(db: Queryable, causationId: string): Promise<boolean> {
  const res = await db.query("SELECT 1 FROM ledger_event WHERE causation_id = $1 LIMIT 1", [causationId]);
  return (res.rowCount ?? 0) > 0;
}

export async function listEventsForAccount(
  db: Queryable,
  accountId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): Promise<LedgerEventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const res = await db.query<LedgerEventRow>(
    `SELECT * FROM ledger_event WHERE account_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [accountId, opts.afterSeq ?? 0, limit],
  );
  return res.rows;
}

/**
 * One page of an account's ledger plus whether more follows (QA-02 S8). `limit` is the
 * page size (1..500); one extra row is fetched to decide `hasMore`.
 */
export async function listEventsPageForAccount(
  db: Queryable,
  accountId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): Promise<{ events: LedgerEventRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const res = await db.query<LedgerEventRow>(
    `SELECT * FROM ledger_event WHERE account_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [accountId, opts.afterSeq ?? 0, limit + 1],
  );
  const hasMore = res.rows.length > limit;
  return { events: hasMore ? res.rows.slice(0, limit) : res.rows, hasMore };
}

export async function listEventsByCausation(db: Queryable, causationId: string): Promise<LedgerEventRow[]> {
  const res = await db.query<LedgerEventRow>(
    "SELECT * FROM ledger_event WHERE causation_id = $1 ORDER BY causation_seq",
    [causationId],
  );
  return res.rows;
}

export async function countEventsForAccount(db: Queryable, accountId: string): Promise<number> {
  const res = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_event WHERE account_id = $1", [
    accountId,
  ]);
  return Number(res.rows[0]!.n);
}
