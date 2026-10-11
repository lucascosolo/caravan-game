/**
 * Process configuration. Not balance — balance constants live in @caravan/content TUNABLES.
 */
export const DEFAULT_DEV_DATABASE_URL = "postgres://caravan:caravan@localhost:5432/caravan";
export const DEFAULT_TEST_DATABASE_URL = "postgres://caravan:caravan@localhost:5432/caravan_test";

export function databaseUrl(): string {
  return process.env["DATABASE_URL"] ?? DEFAULT_DEV_DATABASE_URL;
}

export function testDatabaseUrl(): string {
  return process.env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
}

/** Session lifetime. Operational, not balance. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
