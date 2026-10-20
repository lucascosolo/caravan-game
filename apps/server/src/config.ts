/**
 * Process configuration. Not balance — balance constants live in @caravan/content TUNABLES.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

// ---------------------------------------------------------------------------------
// `.env` loading (final review N2)
// ---------------------------------------------------------------------------------
/**
 * Load `KEY=VALUE` lines from the repo's `.env` (or the file ENV_FILE names) into process.env,
 * NEVER overriding a variable that is already set: the real environment wins, so CI and a process
 * manager are unaffected. The file is found by walking up from the working directory to the
 * workspace root (the directory holding pnpm-workspace.yaml), so `pnpm --filter @caravan/server …`
 * (cwd apps/server) and the built `node apps/server/dist/…` (cwd the repo) both find it. A missing
 * file is not an error. Blank lines and `#` comments are skipped; `export KEY=…` is accepted; a value
 * may be wrapped in single or double quotes. Returns the path read, or null.
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  const file = env["ENV_FILE"] ? path.resolve(cwd, env["ENV_FILE"]) : findWorkspaceDotEnv(cwd);
  if (!file || !existsSync(file)) return null;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value;
  }
  return file;
}

function findWorkspaceDotEnv(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return path.join(dir, ".env");
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// ---------------------------------------------------------------------------------
// Production configuration checks (final review S2)
// ---------------------------------------------------------------------------------
/** Passwords that ship in this repo (db/roles.sql, .env.example). Refused for any connection in production. */
export const DEFAULT_DB_PASSWORDS: readonly string[] = ["caravan", "caravan_app"];

export class ProductionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionConfigError";
  }
}

/**
 * Under NODE_ENV=production a connection string must be given explicitly (no repo default) and its
 * password must not be empty or one of the repo's defaults. `what` names the variable in the
 * message. Outside production this is a no-op.
 */
export function assertProductionDatabaseUrl(env: NodeJS.ProcessEnv, url: string | undefined, what: string): void {
  if (env["NODE_ENV"] !== "production") return;
  if (!url) throw new ProductionConfigError(`${what} must be set when NODE_ENV=production (the repo's default is for local development only)`);
  let password: string;
  try {
    password = decodeURIComponent(new URL(url).password);
  } catch {
    throw new ProductionConfigError(`${what} is not a valid postgres:// URL`);
  }
  if (password === "" || DEFAULT_DB_PASSWORDS.includes(password)) {
    throw new ProductionConfigError(
      `${what} uses ${password === "" ? "no password" : "a default password from this repo"}; set a strong one (docs/PLAYTEST-HOSTING.md, step 2). Refused when NODE_ENV=production`,
    );
  }
}

// ---------------------------------------------------------------------------------
// The store mode (final review D1)
// ---------------------------------------------------------------------------------
/**
 * STORE_MODE:
 *   sandbox  packs can be bought through the sandbox backend ($0, chunk 20). The default outside production.
 *   off      packs are previewed but cannot be bought (POST /me/store/purchase → 409 store_unavailable),
 *            and the dashboard reports no store funnel. The default whenever NODE_ENV=production (the play test).
 * Nothing else in the economy reads it.
 */
export type StoreMode = "sandbox" | "off";

/** Final guardrail review r3 N4: the second switch that lets STORE_MODE=sandbox run under NODE_ENV=production. */
export const STORE_SANDBOX_IN_PRODUCTION_ENV = "STORE_SANDBOX_IN_PRODUCTION";

export function storeSandboxAllowedInProduction(env: NodeJS.ProcessEnv): boolean {
  return (env[STORE_SANDBOX_IN_PRODUCTION_ENV] ?? "").trim() === "1";
}

export function storeModeFromEnv(env: NodeJS.ProcessEnv): StoreMode {
  const v = (env["STORE_MODE"] ?? "").trim();
  if (v === "") return env["NODE_ENV"] === "production" ? "off" : "sandbox";
  // Final guardrail review r3 N4: a play test must never hand out free Coin by accident. Under
  // production the $0 sandbox needs a second, explicit switch (and the server logs a warning).
  if (v === "sandbox" && env["NODE_ENV"] === "production" && !storeSandboxAllowedInProduction(env)) {
    throw new Error(`STORE_MODE=sandbox is refused when NODE_ENV=production: it sells packs for $0 (free Coin). Set STORE_MODE=off, or also set ${STORE_SANDBOX_IN_PRODUCTION_ENV}=1 if that is really meant`);
  }
  if (v === "sandbox" || v === "off") return v;
  throw new Error(`STORE_MODE must be "sandbox" or "off"; got '${v}'`);
}

// ---------------------------------------------------------------------------------
// Single-process hosting (final review S2)
// ---------------------------------------------------------------------------------
/**
 * SERVE_WEB=1: the server also serves the built client (WEB_DIST, default apps/web/dist) and mounts
 * every API route under /api: one process, one origin, behind a TLS reverse proxy
 * (docs/PLAYTEST-HOSTING.md). Unset: the API is mounted at the root, as in dev and the tests.
 */
export interface ServeWebConfig {
  dir: string;
  /** NODE_ENV=production: source maps are never served. */
  production: boolean;
}

export function serveWebFromEnv(env: NodeJS.ProcessEnv, defaultDir: string): ServeWebConfig | null {
  const v = (env["SERVE_WEB"] ?? "").trim();
  if (v === "" || v === "0" || v === "off" || v === "false") return null;
  if (v !== "1" && v !== "on" && v !== "true") throw new Error(`SERVE_WEB must be 1 or unset; got '${v}'`);
  const dir = path.resolve(env["WEB_DIST"] ?? defaultDir);
  if (!existsSync(path.join(dir, "index.html"))) throw new Error(`SERVE_WEB=1 but ${path.join(dir, "index.html")} does not exist (run pnpm build, or set WEB_DIST)`);
  return { dir, production: env["NODE_ENV"] === "production" };
}
