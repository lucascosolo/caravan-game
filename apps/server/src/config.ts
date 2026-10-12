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

/**
 * QA-30 D3: whether the server sits behind a reverse proxy, so per-address rate limits key on the
 * client's address (X-Forwarded-For) rather than the proxy's. TRUST_PROXY:
 *   unset / "off" / "false"      not behind a proxy (default): X-Forwarded-For is ignored;
 *   a positive integer            trust that many proxy hops;
 *   addresses / CIDRs (a,b,...)   trust only those proxies.
 * "true" (trust any hop) is REFUSED: anyone could then set their own address.
 */
export function trustProxyFromEnv(env: NodeJS.ProcessEnv): false | number | string {
  const v = (env["TRUST_PROXY"] ?? "").trim();
  if (v === "" || v === "off" || v === "false") return false;
  if (v === "true") throw new Error("TRUST_PROXY=true is refused: give a hop count or the proxy addresses / CIDRs");
  if (/^[1-9]\d?$/.test(v)) return Number(v);
  const parts = v.split(",").map((p) => p.trim());
  if (parts.every((p) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(p))) return parts.join(",");
  throw new Error(`TRUST_PROXY must be off, a hop count, or proxy addresses / CIDRs; got '${v}'`);
}

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
