// Shared helpers for the repo's node scripts (final review N2 / N6 / N8).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Load the repo's .env (or ENV_FILE) into process.env WITHOUT overriding anything already set —
 * the same rule as apps/server/src/config.ts loadDotEnv. Returns the file read, or null.
 */
export function loadDotEnv(env = process.env) {
  const file = env.ENV_FILE ? path.resolve(repoRoot, env.ENV_FILE) : path.join(repoRoot, ".env");
  if (!existsSync(file)) return null;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
  return file;
}

/**
 * The same database as `ownerUrl`, as the DML-only app role the server runs as (caravan_app;
 * password TEST_APP_DB_PASSWORD, default caravan_app). Mirrors apps/server/test/db-url.ts.
 */
export function appRoleUrl(ownerUrl, env = process.env) {
  const u = new URL(ownerUrl);
  u.username = "caravan_app";
  u.password = env.TEST_APP_DB_PASSWORD ?? "caravan_app";
  return u.toString();
}

/** Final review N6: refuse to start a server on a port something already answers on. */
export async function assertPortFree(host, port, what) {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    throw new Error(`${what}: something already answers on ${host}:${port} (GET /health → ${res.status}); stop it or pick another port`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${what}:`)) throw err;
    // Connection refused / timed out: the port is free.
  }
}

/** Wait until `url` answers 200 with {ok:true}, or the child exits, or the deadline passes. */
export async function waitHealthy(url, child, timeoutMs = 20_000) {
  let exited = false;
  child.on("exit", () => (exited = true));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.ok === true) return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** SIGTERM, then SIGKILL after `graceMs`; resolves once the child is gone. */
export function stop(child, graceMs = 5_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
