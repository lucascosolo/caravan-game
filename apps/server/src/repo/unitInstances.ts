import { TUNABLES } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import type { UnitInstanceRow } from "../db/types.js";

export async function createUnitInstance(
  db: Queryable,
  input: { caravanId: string; unitTypeId: string; mergeLevel?: number },
): Promise<UnitInstanceRow> {
  const mergeLevel = input.mergeLevel ?? TUNABLES.MERGE_LEVEL_MIN;
  if (
    !Number.isInteger(mergeLevel) ||
    mergeLevel < TUNABLES.MERGE_LEVEL_MIN ||
    mergeLevel > TUNABLES.MERGE_LEVEL_MAX
  ) {
    throw new RangeError(`merge level must be ${TUNABLES.MERGE_LEVEL_MIN}..${TUNABLES.MERGE_LEVEL_MAX}, got ${mergeLevel}`);
  }
  const res = await db.query<UnitInstanceRow>(
    `INSERT INTO unit_instance (caravan_id, unit_type_id, merge_level) VALUES ($1, $2, $3) RETURNING *`,
    [input.caravanId, input.unitTypeId, mergeLevel],
  );
  return res.rows[0]!;
}

export async function listUnitInstancesForCaravan(db: Queryable, caravanId: string): Promise<UnitInstanceRow[]> {
  const res = await db.query<UnitInstanceRow>(
    "SELECT * FROM unit_instance WHERE caravan_id = $1 ORDER BY created_at, id",
    [caravanId],
  );
  return res.rows;
}
