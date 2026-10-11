/**
 * Vitest global setup: points the suite at the TEST database and resets the schema
 * (roll everything back, then migrate up) so every run starts from a known state.
 */
import { migrateReset } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { resolveTestDatabaseUrl } from "./db-url.js";

export default async function setup(): Promise<void> {
  const url = resolveTestDatabaseUrl();
  const pool = createPool(url);
  try {
    await migrateReset(pool);
  } finally {
    await pool.end();
  }
}
