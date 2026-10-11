/**
 * Process configuration. Not balance — balance constants live in @caravan/content TUNABLES.
 */
/**
 * Two Postgres roles, two URLs (see apps/server/db/roles.sql):
 *   DATABASE_URL          the RUNNING SERVER: `caravan_app`, a plain DML-only login role that
 *                         cannot ALTER/TRUNCATE/disable the schema's permanence guards.
 *   MIGRATE_DATABASE_URL  migrations, db:roles and the test suite's schema reset: the owner
 *                         role `caravan`. Falls back to DATABASE_URL when unset.
 */
export const DEFAULT_DEV_DATABASE_URL = "postgres://caravan_app:caravan_app@localhost:5432/caravan";
export const DEFAULT_MIGRATE_DATABASE_URL = "postgres://caravan:caravan@localhost:5432/caravan";
export const DEFAULT_TEST_DATABASE_URL = "postgres://caravan:caravan@localhost:5432/caravan_test";

/** Connection string for the server process (DML-only app role). */
export function databaseUrl(): string {
  return process.env["DATABASE_URL"] ?? DEFAULT_DEV_DATABASE_URL;
}

/** Connection string for migrations and role setup (schema owner). */
export function migrateDatabaseUrl(): string {
  return process.env["MIGRATE_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? DEFAULT_MIGRATE_DATABASE_URL;
}

/** Owner-role connection string for the test database (the suite resets its schema). */
export function testDatabaseUrl(): string {
  return process.env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
}

/** Login role the server runs as; tests connect as it to prove the guards hold against it. */
export const APP_DB_ROLE = "caravan_app";
export const APP_DB_ROLE_DEFAULT_PASSWORD = "caravan_app";

/** Session lifetime. Operational, not balance. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
/** Upper bound so a hostile body can't make scrypt chew on megabytes. */
export const PASSWORD_MAX = 128;
export const CARAVAN_NAME_MIN = 1;
export const CARAVAN_NAME_MAX = 40;
/** Live sessions kept per account; issuing one beyond this evicts the oldest. */
export const SESSIONS_PER_ACCOUNT_MAX = 10;
