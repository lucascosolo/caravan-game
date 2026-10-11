/**
 * Chunk 30: the store's part of an account's JSON export (`GET /me/export`). The store's
 * tables are read only from src/store (store-guards.test.ts), so the export asks here.
 */
import type { Queryable } from "../db/pool.js";

export async function storeRecordsForExport(db: Queryable, accountId: string): Promise<{ purchases: unknown[]; cosmetics: unknown[]; cosmeticsEquipped: unknown[] }> {
  const purchases = (await db.query("SELECT * FROM pack_purchase WHERE account_id = $1 ORDER BY purchased_at, id", [accountId])).rows;
  const cosmetics = (await db.query("SELECT cosmetic_id, purchase_id FROM cosmetic_ownership WHERE account_id = $1 ORDER BY cosmetic_id", [accountId])).rows;
  const cosmeticsEquipped = (await db.query("SELECT slot, cosmetic_id FROM cosmetic_equip WHERE account_id = $1 ORDER BY slot", [accountId])).rows;
  return { purchases, cosmetics, cosmeticsEquipped };
}
