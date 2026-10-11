import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appliedMigrationIds, applyRoles, loadMigrations, migrateDown, migrateUp } from "../src/db/migrate.js";
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

  // This file recreates every table; re-apply the column-level grants so later files that
  // assert the app role's privileges do not depend on file order.
  afterAll(async () => {
    await migrateUp(pool);
    await applyRoles(pool);
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
      "account", "account_erasure_active", "account_erasure_audit", "account_onboarding", "authored_party", "caravan", "cosmetic_equip", "cosmetic_ownership", "device", "encounter_candidates", "encounter_log", "encounter_log_retention", "home_town", "inbox_preference", "inbox_read", "ledger_event", "ledger_snapshot", "pack_purchase", "pool_progress", "refugee_menu", "region",
      "resolution_job", "schema_migrations", "session", "standing_party", "trip", "trip_cap", "trip_cap_use", "trip_encounter", "unit_instance",
      "wagon_formation", "wagon_manifest",
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

  it("does not model a persistent defensive layout, and the only purchase-shaped table is chunk 20's sandboxed pack record", async () => {
    const names = await tableNames();
    for (const forbidden of ["base", "layout", "defense", "billing", "entitlement"]) {
      expect(names.some((n) => n.includes(forbidden)), `table matching '${forbidden}'`).toBe(false);
    }
    // Chunk 20 (store-guards.test.ts proves nothing battle-side references it).
    expect(names.filter((n) => n.includes("purchase"))).toEqual(["pack_purchase"]);
    // A formation may exist only per ENCOUNTER of a trip-locked manifest (chunk 07), never as
    // a standing layout: every formation-shaped table is keyed by encounter, not by owner.
    for (const table of names.filter((n) => n.includes("formation"))) {
      const cols = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
        [table],
      );
      const columns = cols.rows.map((r) => r.column_name);
      expect(columns, table).toContain("encounter_index");
      expect(columns.filter((c) => /account|caravan/.test(c)), table).toEqual([]);
    }
  });
});
