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

/** Run a statement and return the error it throws (or null). */
export async function expectDbError(db: pg.Pool, sql: string, params: unknown[] = []): Promise<(Error & { code?: string }) | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (err) {
    return err as Error & { code?: string };
  }
}

export function unique(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
