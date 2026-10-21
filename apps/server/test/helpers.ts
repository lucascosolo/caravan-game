import type pg from "pg";
import { TUNABLES } from "@caravan/content";
import { createPool } from "../src/db/pool.js";
import { appRoleUrl, resolveTestDatabaseUrl } from "./db-url.js";

export function testPool(): pg.Pool {
  return createPool(resolveTestDatabaseUrl());
}

/**
 * Wipe all game rows (not the schema). DELETE, not TRUNCATE: the schema refuses TRUNCATE
 * on guarded tables, and a row-wise delete of every account cascades through the delete
 * guards legitimately (the owner is gone by the time the cascade fires).
 */
export async function truncateAll(db: pg.Pool): Promise<void> {
  await db.query("DELETE FROM account");
}

/** A pool connected as the DML-only app role (what the server runs as). */
export function appRolePool(): pg.Pool {
  return createPool(appRoleUrl(resolveTestDatabaseUrl()));
}

/**
 * Run a statement and return the error it throws (or null).
 *
 * node-pg rejects a query on the server's ErrorResponse, which Postgres sends BEFORE it
 * aborts the failed transaction, so for a moment the backend still holds the row locks the
 * failed statement took. A test that next leases on ANOTHER connection (`FOR UPDATE SKIP
 * LOCKED`) could skip the very row it just probed and see an empty queue (qa02-round2's
 * "idle where completed was expected", only under CPU load). So the statement runs on a
 * dedicated connection, and one more round trip on that connection (answered only after the
 * abort has released its locks) completes before this returns.
 */
export async function expectDbError(db: pg.Pool, sql: string, params: unknown[] = []): Promise<(Error & { code?: string }) | null> {
  const client = await db.connect();
  try {
    await client.query(sql, params);
    return null;
  } catch (err) {
    return err as Error & { code?: string };
  } finally {
    await client.query("SELECT 1").catch(() => undefined);
    client.release();
  }
}

export function unique(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Chunk 15 QA N4: `POST /caravans/:id/encounters/:n/formation/commit` now refuses outside an
 * open trip with a chosen candidate. Chunk 07's model tests (packing and arranging in town,
 * outcomes applied by hand) commit through the SERVICE instead; this answers in the route's
 * response shape so those tests read the same. Returns null for any other request.
 */
export async function commitFormationInTown(db: pg.Pool, ownCaravanId: string, method: string, url: string): Promise<{ statusCode: number; body: string; json: () => any } | null> {
  const m = /^\/caravans\/([^/]+)\/encounters\/(\d+)\/formation\/commit$/.exec(url);
  if (method !== "POST" || !m || m[1] !== ownCaravanId) return null;
  const { withTransaction } = await import("../src/db/pool.js");
  const { findCaravanById } = await import("../src/repo/caravans.js");
  const { commitFormation } = await import("../src/circle/service.js");
  const reply = (statusCode: number, value: unknown) => ({ statusCode, body: JSON.stringify(value), json: () => JSON.parse(JSON.stringify(value)) });
  try {
    const caravan = await findCaravanById(db, ownCaravanId);
    const formation = await withTransaction(db, (c) => commitFormation(c, caravan!, Number(m[2])));
    return reply(200, { formation });
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string; issues?: unknown };
    if (typeof e.statusCode !== "number") throw err;
    return reply(e.statusCode, { error: e.code, message: e.message, ...(e.issues ? { issues: e.issues } : {}) });
  }
}

/**
 * TEST FIXTURE (final play-test review r2 S2 / r3 S2(a)): give a caravan AUTHORED_ONLY_UNTIL_BANKS
 * banked trips a day ago, so the trip a test then starts meets live parties as well as authored ones
 * (a caravan meets authored outfits only until it has banked TUNABLES.AUTHORED_ONLY_UNTIL_BANKS
 * trips). Empty, closed manifests and ended trips (end_reason 'banked'), written as the owner role;
 * nothing else reads them.
 */
export async function seasonCaravan(db: pg.Pool, caravanId: string): Promise<void> {
  const empty = JSON.stringify({ v: 1, units: [], traps: [], fences: [] });
  for (let i = 0; i < Math.max(1, TUNABLES.AUTHORED_ONLY_UNTIL_BANKS); i++) {
    await db.query(
      `WITH m AS (
         INSERT INTO wagon_manifest (caravan_id, packed, survivors, closed_at, created_at)
         VALUES ($1, $2::jsonb, $2::jsonb, now() - interval '1 day', now() - interval '1 day') RETURNING id
       )
       INSERT INTO trip (caravan_id, manifest_id, battlefield_version, started_at, ended_at, end_reason) SELECT $1, m.id, 3, now() - interval '1 day', now() - interval '1 day', 'banked' FROM m`,
      [caravanId, empty],
    );
  }
}

/**
 * TEST FIXTURE (final play-test review r2 N16): the name a player's party is served under — its
 * caravan's name, never the username. Looks up the caravan of the account with this username (or
 * returns the argument unchanged when it is no username, e.g. a guest caravan's name already).
 */
export async function servedNameOf(db: pg.Pool, usernameOrName: string): Promise<string> {
  const res = await db.query<{ name: string }>("SELECT c.name FROM caravan c JOIN account a ON a.id = c.account_id WHERE a.username = $1 ORDER BY c.created_at LIMIT 1", [usernameOrName]);
  return res.rows[0]?.name ?? usernameOrName;
}
