/**
 * Vitest global setup: points the suite at the TEST database and resets the schema
 * (roll everything back, then migrate up) so every run starts from a known state, then
 * applies db/roles.sql so the DML-only app role exists and holds grants on the fresh
 * tables. Both steps run as the OWNER role (TEST_DATABASE_URL); individual tests that
 * prove the guards hold against the server's role connect via helpers.appRolePool().
 */
import { applyRoles, migrateReset } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { resolveTestDatabaseUrl } from "./db-url.js";

export default async function setup(): Promise<void> {
  const url = resolveTestDatabaseUrl();
  const pool = createPool(url);
  try {
    await migrateReset(pool);
    await applyRoles(pool);
  } finally {
    await pool.end();
  }
}
