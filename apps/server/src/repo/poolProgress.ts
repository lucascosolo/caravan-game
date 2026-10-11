/**
 * Pool progress data access. Note what is deliberately ABSENT here:
 *   - no function lowers ladder_level or unlock_points_granted (and the DB trigger refuses it);
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

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * Raise a ladder by exactly one rung. Increments only; the DB trigger refuses anything
 * else. Chunk 04 wires rung-crossing to grants and the ledger.
 */
export async function raiseLadderLevel(db: Queryable, progressId: string): Promise<PoolProgressRow> {
  const res = await db.query<PoolProgressRow>(
    "UPDATE pool_progress SET ladder_level = ladder_level + 1 WHERE id = $1 RETURNING *",
    [progressId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`pool_progress ${progressId} not found`);
  return row;
}

/** Grant unlock points. `points` must be a positive integer; there is no revoke. */
export async function grantUnlockPoints(db: Queryable, progressId: string, points: number): Promise<PoolProgressRow> {
  assertPositiveInt("points", points);
  const res = await db.query<PoolProgressRow>(
    "UPDATE pool_progress SET unlock_points_granted = unlock_points_granted + $2 WHERE id = $1 RETURNING *",
    [progressId, points],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`pool_progress ${progressId} not found`);
  return row;
}

export function isAccountPool(pool: Pool): pool is AccountPool {
  return pool === "trap" || pool === "siege";
}
