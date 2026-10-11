/**
 * Chunk 30 (QA D4): the analytics part of an account's JSON export. Analytics tables are read
 * only from src/analytics (telemetry.test.ts), so the export asks here.
 */
import type { Queryable } from "../db/pool.js";

export async function analyticsRecordsForExport(db: Queryable, accountId: string): Promise<{ analytics: unknown; clientEvents: unknown[] }> {
  const a = (await db.query<{ analytics_id: string; opted_out: boolean; updated_at: Date }>("SELECT analytics_id, opted_out, updated_at FROM account_analytics WHERE account_id = $1", [accountId])).rows[0];
  if (!a) return { analytics: null, clientEvents: [] };
  const events = (await db.query("SELECT kind, screen, error_name, stack_hash, occurred_at, received_at FROM analytics_client_event WHERE analytics_id = $1 ORDER BY occurred_at, id", [a.analytics_id])).rows;
  return { analytics: a, clientEvents: events };
}
