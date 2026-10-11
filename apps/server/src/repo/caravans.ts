import type { RegionId } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import type { CaravanRow, CaravanState } from "../db/types.js";

export async function insertCaravan(
  db: Queryable,
  input: { accountId: string; regionId: RegionId; name: string },
): Promise<CaravanRow> {
  const res = await db.query<CaravanRow>(
    `INSERT INTO caravan (account_id, region_id, name) VALUES ($1, $2, $3) RETURNING *`,
    [input.accountId, input.regionId, input.name],
  );
  return res.rows[0]!;
}

export async function findCaravanById(db: Queryable, id: string): Promise<CaravanRow | null> {
  const res = await db.query<CaravanRow>("SELECT * FROM caravan WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

/** Always a list: the schema supports N caravans per account even though v1 makes one. */
export async function listCaravansForAccount(db: Queryable, accountId: string): Promise<CaravanRow[]> {
  const res = await db.query<CaravanRow>(
    "SELECT * FROM caravan WHERE account_id = $1 ORDER BY created_at, id",
    [accountId],
  );
  return res.rows;
}

export async function countCaravansForAccount(db: Queryable, accountId: string): Promise<number> {
  const res = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM caravan WHERE account_id = $1", [
    accountId,
  ]);
  return Number(res.rows[0]!.n);
}

export async function setCaravanState(db: Queryable, caravanId: string, state: CaravanState): Promise<CaravanRow> {
  const res = await db.query<CaravanRow>("UPDATE caravan SET state = $2 WHERE id = $1 RETURNING *", [
    caravanId,
    state,
  ]);
  const row = res.rows[0];
  if (!row) throw new Error(`caravan ${caravanId} not found`);
  return row;
}
