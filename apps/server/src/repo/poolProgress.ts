/**
 * Pool progress data access. Note what is deliberately ABSENT here:
 *   - no function writes ladder_level, ladder_points or unlock_points_granted at all —
 *     they are projections of ledger events (chunk 02/04); the DB trigger refuses a decrease;
 *   - no function debits reputation as a cost — it is a rating, adjusted by fight outcomes
 *     (chunk 04), never spent;
 *   - no function takes an account id for the living pool or a caravan id for trap/siege.
 * The scope split is encoded in the function signatures AND the check constraint.
 */
import { TUNABLES } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import type { Pool, PoolProgressRow } from "../db/types.js";

export type AccountPool = "trap" | "siege";
export const ACCOUNT_POOLS: readonly AccountPool[] = ["trap", "siege"];

export async function createAccountPoolProgress(
  db: Queryable,
  accountId: string,
  pool: AccountPool,
): Promise<PoolProgressRow> {
  const res = await db.query<PoolProgressRow>(
    `INSERT INTO pool_progress (pool, account_id, reputation) VALUES ($1, $2, $3) RETURNING *`,
    [pool, accountId, TUNABLES.REPUTATION_START],
  );
  return res.rows[0]!;
}

export async function createCaravanPoolProgress(db: Queryable, caravanId: string): Promise<PoolProgressRow> {
  const res = await db.query<PoolProgressRow>(
    `INSERT INTO pool_progress (pool, caravan_id, reputation) VALUES ('living', $1, $2) RETURNING *`,
    [caravanId, TUNABLES.REPUTATION_START],
  );
  return res.rows[0]!;
}

export async function getAccountPoolProgress(
  db: Queryable,
  accountId: string,
  pool: AccountPool,
): Promise<PoolProgressRow | null> {
  const res = await db.query<PoolProgressRow>(
    "SELECT * FROM pool_progress WHERE account_id = $1 AND pool = $2",
    [accountId, pool],
  );
  return res.rows[0] ?? null;
}

export async function getCaravanPoolProgress(db: Queryable, caravanId: string): Promise<PoolProgressRow | null> {
  const res = await db.query<PoolProgressRow>(
    "SELECT * FROM pool_progress WHERE caravan_id = $1 AND pool = 'living'",
    [caravanId],
  );
  return res.rows[0] ?? null;
}

/** All progress rows an account can see: its own trap/siege rows plus the living row of each caravan. */
export async function listPoolProgressForAccount(db: Queryable, accountId: string): Promise<PoolProgressRow[]> {
  const res = await db.query<PoolProgressRow>(
    `SELECT pp.* FROM pool_progress pp
     LEFT JOIN caravan c ON c.id = pp.caravan_id
     WHERE pp.account_id = $1 OR c.account_id = $1
     ORDER BY pp.pool, pp.created_at`,
    [accountId],
  );
  return res.rows;
}

// Deliberately no raiseLadderLevel / grantUnlockPoints here (chunk 04 QA S6): the ONLY
// writer of ladder_level, ladder_points and unlock_points_granted is the ledger's
// projection trigger, fed by progression/outcome.ts. A repo-level UPDATE would move a
// balance with no event to explain it.

export function isAccountPool(pool: Pool): pool is AccountPool {
  return pool === "trap" || pool === "siege";
}
