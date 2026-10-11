import type pg from "pg";
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
