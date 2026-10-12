/**
 * Plain-SQL migration runner. Migrations live in apps/server/migrations as paired files
 * `NNN_name.up.sql` / `NNN_name.down.sql`. Each migration runs in its own transaction and
 * is recorded in `schema_migrations`.
 *
 * Runs as the schema OWNER role (MIGRATE_DATABASE_URL); the server itself runs as the
 * DML-only role that db/roles.sql creates. `roles` applies that script.
 *
 * CLI:  tsx src/db/migrate.ts up | down [steps] | reset | status | roles
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { assertProductionDatabaseUrl, loadDotEnv, migrateDatabaseUrl } from "../config.js";
import { createPool } from "./pool.js";

export interface Migration {
  id: number;
  name: string;
  up: string;
  down: string;
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const ROLES_SQL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/roles.sql");

/**
 * Migrations are ordered by their PARSED numeric id, not by file name: "10_x" must run
 * after "9_x". Two files with the same id (however padded) are an error, because the
 * applied-ids table could not tell them apart.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir);
  const ups = files.filter((f) => f.endsWith(".up.sql"));
  const migrations = ups.map((file) => {
    const match = /^(\d+)_(.+)\.up\.sql$/.exec(file);
    if (!match) throw new Error(`Migration file name not understood: ${file}`);
    const id = Number(match[1]);
    const name = match[2]!;
    const downFile = `${match[1]}_${name}.down.sql`;
    if (!files.includes(downFile)) throw new Error(`Migration ${file} has no matching ${downFile}`);
    return {
      id,
      name,
      up: readFileSync(path.join(dir, file), "utf8"),
      down: readFileSync(path.join(dir, downFile), "utf8"),
    };
  });
  migrations.sort((a, b) => a.id - b.id);
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1]!;
    const cur = migrations[i]!;
    if (prev.id === cur.id) {
      throw new Error(`Duplicate migration id ${cur.id}: ${prev.id}_${prev.name} and ${cur.id}_${cur.name}`);
    }
  }
  return migrations;
}

/** Create/refresh the DML-only app role and its grants (db/roles.sql). Owner connection. */
export async function applyRoles(pool: pg.Pool, file: string = ROLES_SQL): Promise<void> {
  await pool.query(readFileSync(file, "utf8"));
}

async function ensureTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

export async function appliedMigrationIds(pool: pg.Pool): Promise<number[]> {
  await ensureTable(pool);
  const res = await pool.query<{ id: number }>("SELECT id FROM schema_migrations ORDER BY id");
  return res.rows.map((r) => r.id);
}

export async function migrateUp(pool: pg.Pool, migrations: Migration[] = loadMigrations()): Promise<string[]> {
  const applied = new Set(await appliedMigrationIds(pool));
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(m.up);
      await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [m.id, m.name]);
      await client.query("COMMIT");
      ran.push(`${m.id}_${m.name}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Migration ${m.id}_${m.name} (up) failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

/**
 * Roll back the most recent `steps` migrations, newest first, ALL IN ONE TRANSACTION
 * (chunk 25 QA S1). Some down migrations refuse while data they would orphan or de-guard
 * exists (009 and 011 refuse while system accounts exist); running the whole batch
 * atomically is the pre-check: if any step's guard refuses, nothing is rolled back — a
 * `down N` or a `reset` never stops halfway with some migrations gone and others applied.
 * Postgres DDL is transactional, so this is exact, not a best-effort dry run.
 */
export async function migrateDown(
  pool: pg.Pool,
  steps = 1,
  migrations: Migration[] = loadMigrations(),
): Promise<string[]> {
  const applied = await appliedMigrationIds(pool);
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const plan: Migration[] = [];
  for (const id of applied.slice().reverse().slice(0, steps)) {
    const m = byId.get(id);
    if (!m) throw new Error(`Applied migration ${id} has no file on disk; cannot roll back`);
    plan.push(m);
  }
  if (plan.length === 0) return [];
  const client = await pool.connect();
  let current: Migration | undefined;
  try {
    await client.query("BEGIN");
    for (const m of plan) {
      current = m;
      await client.query(m.down);
      await client.query("DELETE FROM schema_migrations WHERE id = $1", [m.id]);
    }
    await client.query("COMMIT");
    return plan.map((m) => `${m.id}_${m.name}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    const rest = plan.length > 1 ? `; nothing was rolled back (${plan.length} steps run as one transaction)` : "";
    throw new Error(`Migration ${current!.id}_${current!.name} (down) failed: ${(err as Error).message}${rest}`);
  } finally {
    client.release();
  }
}

/** Roll everything back, then apply everything. Used by the test suite. */
export async function migrateReset(pool: pg.Pool, migrations: Migration[] = loadMigrations()): Promise<void> {
  const applied = await appliedMigrationIds(pool);
  await migrateDown(pool, applied.length, migrations);
  await migrateUp(pool, migrations);
}

async function main(): Promise<void> {
  const [command = "up", arg] = process.argv.slice(2);
  // Final review N2 / S2: the repo's .env, then no repo-default password in production.
  loadDotEnv();
  assertProductionDatabaseUrl(process.env, process.env["MIGRATE_DATABASE_URL"] ?? process.env["DATABASE_URL"], "MIGRATE_DATABASE_URL");
  const pool = createPool(migrateDatabaseUrl());
  try {
    switch (command) {
      case "up": {
        const ran = await migrateUp(pool);
        console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Nothing to apply.");
        await applyRoles(pool);
        break;
      }
      case "down": {
        const ran = await migrateDown(pool, arg ? Number(arg) : 1);
        console.log(ran.length ? `Rolled back: ${ran.join(", ")}` : "Nothing to roll back.");
        break;
      }
      case "reset": {
        await migrateReset(pool);
        await applyRoles(pool);
        console.log("Reset complete.");
        break;
      }
      case "roles": {
        await applyRoles(pool);
        console.log("Applied db/roles.sql (caravan_app role + grants).");
        break;
      }
      case "status": {
        const applied = new Set(await appliedMigrationIds(pool));
        for (const m of loadMigrations()) {
          console.log(`${applied.has(m.id) ? "[x]" : "[ ]"} ${m.id}_${m.name}`);
        }
        break;
      }
      default:
        throw new Error(`Unknown command '${command}'. Use: up | down [steps] | reset | status | roles`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
