/**
 * Vitest setupFiles: runs in each test file's worker BEFORE the file is imported, so every
 * file starts from the same database baseline whatever ran before it (the suite shares one
 * database and runs files one at a time, in an order vitest may shuffle).
 *
 * The baseline, restored as the OWNER role (TEST_DATABASE_URL):
 *   - the schema fully migrated and db/roles.sql applied (migrations.test.ts rolls the schema
 *     down and back up; a file that fails mid-way must not leave the next one without tables
 *     or grants);
 *   - no game rows: `DELETE FROM account` cascades to every mutable table (caravans, ledger,
 *     resolution jobs and their encounter logs, standing and authored parties, matchmaking
 *     menus, ratings, trips, trip caps, purchases, inbox, onboarding). DELETE, not TRUNCATE:
 *     the guards refuse TRUNCATE and let a row go once its account is gone;
 *   - then a check that nothing else holds rows except the migration-seeded reference tables
 *     below. A new table that is neither account-scoped (ON DELETE CASCADE from account) nor
 *     listed here fails every file loudly, here, instead of leaking state between files.
 *
 * Tests that prove the caravan_app restrictions still connect as caravan_app themselves
 * (helpers.appRolePool()); only this reset uses the owner role.
 *
 * Rule for new tests (AGENTS.md): never rely on rows another file left (or did not leave);
 * create what the file needs in its own beforeAll, and pin anything a matchmaking draw reads.
 */
import { applyRoles, migrateUp } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { resolveTestDatabaseUrl } from "./db-url.js";

/** Rows seeded by migrations and never written by the game: kept as they are. */
const REFERENCE_TABLES = new Set(["schema_migrations", "region", "encounter_log_retention"]);

export async function resetToBaseline(): Promise<void> {
  const pool = createPool(resolveTestDatabaseUrl());
  try {
    await migrateUp(pool);
    await applyRoles(pool);
    await pool.query("DELETE FROM account");
    const tables = (
      await pool.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
    ).rows.map((r) => r.t).filter((t) => !REFERENCE_TABLES.has(t));
    if (tables.length === 0) return;
    const probe = tables.map((t) => `SELECT '${t}' AS t WHERE EXISTS (SELECT 1 FROM "${t}")`).join(" UNION ALL ");
    const dirty = (await pool.query<{ t: string }>(probe)).rows.map((r) => r.t);
    if (dirty.length > 0) {
      throw new Error(
        `per-file reset: ${dirty.join(", ")} still hold rows after DELETE FROM account. Make the table cascade from account, ` +
          `or (reference data seeded by a migration only) add it to REFERENCE_TABLES in test/per-file-reset.ts.`,
      );
    }
  } finally {
    await pool.end();
  }
}

// Top-level await: done before the test file is even imported (some files build pools and apps at module scope).
await resetToBaseline();
