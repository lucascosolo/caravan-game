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

/** Take the per-account append lock for the rest of the current transaction. */
export async function lockAccountForAppend(client: pg.PoolClient, accountId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK_NS_ACCOUNT, accountId]);
}

/** Take the per-caravan resolution lock (TRIP_LOCK_MODE) for the rest of the transaction. */
export async function lockCaravanForResolution(client: pg.PoolClient, caravanId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK_NS_CARAVAN, caravanId]);
}

/**
 * Append a batch of events under one causation id, inside the caller's transaction.
 * Events get causation_seq 0..n-1 in array order. Account locks are taken in sorted id
 * order (deadlock-free across concurrent batches). A retried cause that already committed
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
