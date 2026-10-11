import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appliedMigrationIds, loadMigrations, migrateDown, migrateUp } from "../src/db/migrate.js";
import { testPool } from "./helpers.js";

const pool = testPool();
afterAll(() => pool.end());

async function tableNames(): Promise<string[]> {
  const res = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return res.rows.map((r) => r.table_name);
}

describe("migrations", () => {
  beforeAll(async () => {
    await migrateUp(pool);
  });

  it("every up migration has a down", () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    for (const m of migrations) {
      expect(m.up.trim().length).toBeGreaterThan(0);
      expect(m.down.trim().length).toBeGreaterThan(0);
    }
  });

  it("runs clean from empty, rolls back to empty, and runs clean again", async () => {
    const all = loadMigrations();
    // Roll everything back.
    await migrateDown(pool, all.length);
    expect(await appliedMigrationIds(pool)).toEqual([]);
    expect(await tableNames()).toEqual(["schema_migrations"]);

    // Up from empty.
    const ran = await migrateUp(pool);
    expect(ran.length).toBe(all.length);
    expect(await appliedMigrationIds(pool)).toEqual(all.map((m) => m.id));
    expect(await tableNames()).toEqual([
      "account", "caravan", "home_town", "ledger_event", "ledger_snapshot", "pool_progress", "region",
      "resolution_job", "schema_migrations", "session", "standing_party", "unit_instance",
    ]);

    // Down one step, then back up: the pair is reversible.
    await migrateDown(pool, 1);
    expect((await appliedMigrationIds(pool)).length).toBe(all.length - 1);
    await migrateUp(pool);
    expect((await appliedMigrationIds(pool)).length).toBe(all.length);

    // Idempotent: nothing more to apply.
    expect(await migrateUp(pool)).toEqual([]);
  });

  it("seeds the region table to match @caravan/content", async () => {
    const { REGIONS, TUNABLES } = await import("@caravan/content");
    const res = await pool.query<{ id: string; display_name: string }>("SELECT id, display_name FROM region ORDER BY id");
    expect(res.rows.map((r) => r.id).sort()).toEqual([...REGIONS.map((r) => r.id)].sort());
    expect(REGIONS.length).toBe(TUNABLES.REGION_COUNT);
  });

  it("does not model a persistent defensive layout or a billing table", async () => {
    const names = await tableNames();
    for (const forbidden of ["base", "layout", "formation", "defense", "purchase", "billing", "entitlement"]) {
      expect(names.some((n) => n.includes(forbidden)), `table matching '${forbidden}'`).toBe(false);
    }
  });
});
