import type pg from "pg";
import { createPool } from "../src/db/pool.js";
import { resolveTestDatabaseUrl } from "./db-url.js";

export function testPool(): pg.Pool {
  return createPool(resolveTestDatabaseUrl());
}

/** Wipe all game rows (not the schema). Account cascades to everything else. */
export async function truncateAll(db: pg.Pool): Promise<void> {
  await db.query("TRUNCATE account CASCADE");
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
