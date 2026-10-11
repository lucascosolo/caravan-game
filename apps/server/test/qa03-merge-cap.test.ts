/**
 * Chunk 03 QA S7: migration 001 hard-codes `CHECK (merge_level BETWEEN 1 AND 5)` on
 * unit_instance. That duplicates TUNABLES.MERGE_LEVEL_MIN / MERGE_LEVEL_MAX (fixed by design,
 * GUARDRAILS §2: merge cap is level 5 for everyone). This test pins the two together, in the
 * migration text AND in the live constraint, so neither can drift from the other silently.
 */
import { TUNABLES } from "@caravan/content";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "../src/db/migrate.js";
import { registerAccount } from "../src/services/onboarding.js";
import { expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
afterAll(() => pool.end());

const BETWEEN = /CHECK\s*\(\s*merge_level\s+BETWEEN\s+(\d+)\s+AND\s+(\d+)\s*\)/i;

describe("unit_instance merge-level CHECK equals the registry's merge cap", () => {
  beforeAll(async () => {
    await migrateUp(pool);
  });

  it("the migration source bounds equal MERGE_LEVEL_MIN / MERGE_LEVEL_MAX", () => {
    const m001 = loadMigrations().find((m) => m.id === 1);
    expect(m001).toBeDefined();
    const match = BETWEEN.exec(m001!.up);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(TUNABLES.MERGE_LEVEL_MIN);
    expect(Number(match![2])).toBe(TUNABLES.MERGE_LEVEL_MAX);
  });

  it("the live constraint in the database carries the same bounds", async () => {
    const res = await pool.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'unit_instance_merge_level_range'",
    );
    expect(res.rows).toHaveLength(1);
    // Postgres normalises BETWEEN to a >= / <= pair; read both bounds back out.
    const def = res.rows[0]!.def;
    const lo = /merge_level\s*>=\s*(\d+)/.exec(def);
    const hi = /merge_level\s*<=\s*(\d+)/.exec(def);
    expect(lo, def).not.toBeNull();
    expect(hi, def).not.toBeNull();
    expect(Number(lo![1])).toBe(TUNABLES.MERGE_LEVEL_MIN);
    expect(Number(hi![1])).toBe(TUNABLES.MERGE_LEVEL_MAX);
  });

  it("the database refuses one above the cap and one below the floor, and accepts both ends", async () => {
    await truncateAll(pool);
    const { caravan } = await registerAccount(pool, { username: unique("qa03"), password: "password123", regionId: "desert" });
    const insert = "INSERT INTO unit_instance (caravan_id, unit_type_id, merge_level) VALUES ($1, 'desert.dust_rider', $2)";
    const above = await expectDbError(pool, insert, [caravan.id, TUNABLES.MERGE_LEVEL_MAX + 1]);
    expect(above?.code).toBe("23514");
    expect(above?.message).toContain("unit_instance_merge_level_range");
    const below = await expectDbError(pool, insert, [caravan.id, TUNABLES.MERGE_LEVEL_MIN - 1]);
    expect(below?.code).toBe("23514");
    expect(await expectDbError(pool, insert, [caravan.id, TUNABLES.MERGE_LEVEL_MIN])).toBeNull();
    expect(await expectDbError(pool, insert, [caravan.id, TUNABLES.MERGE_LEVEL_MAX])).toBeNull();
  });
});
