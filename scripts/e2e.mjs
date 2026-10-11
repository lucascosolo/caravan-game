#!/usr/bin/env node
// `pnpm e2e` — run the web client's Playwright smoke test against the BUILT server (chunk 06).
//
// Expects `pnpm build` to have run (apps/server/dist and apps/web/dist) and a MIGRATED
// database at E2E_DATABASE_URL (falls back to TEST_DATABASE_URL, then DATABASE_URL). It
// seeds the dev account (idempotent), starts the built server on E2E_PORT (default 3917),
// waits for GET /health, runs `pnpm --filter @caravan/web e2e` with the preview proxy
// pointed at that port, then stops the server. Exit code is Playwright's.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(repoRoot, "apps", "server", "dist", "index.js");
const seedEntry = path.join(repoRoot, "apps", "server", "dist", "seed.js");
const webDist = path.join(repoRoot, "apps", "web", "dist", "index.html");
for (const f of [serverEntry, seedEntry, webDist]) {
  if (!existsSync(f)) {
    console.error(`e2e: ${path.relative(repoRoot, f)} not found; run \`pnpm build\` first.`);
    process.exit(1);
  }
}

const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("e2e: set E2E_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL) to a migrated database.");
  process.exit(1);
}
const port = Number(process.env.E2E_PORT ?? 3917);
const host = "127.0.0.1";
const env = { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), HOST: host, NODE_ENV: "production" };

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: "inherit", ...opts });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

// 1. Seed (idempotent: a no-op when `dev` already exists).
const seedCode = await run(process.execPath, [seedEntry], { env });
if (seedCode !== 0) process.exit(seedCode);

// 1b. Chunk 08: a run-unique account for the formation e2e. Trip state (a locked manifest,
// a committed formation) is never reset by design, so the formation spec needs an account
// that starts in town every run. Same roster as `dev` (seed.ts honours the override).
const formationUser = process.env.E2E_FORMATION_USERNAME ?? `e2e_formation_${Date.now().toString(36)}`;
const formationPassword = process.env.E2E_FORMATION_PASSWORD ?? "e2epassword";
const seed2 = await run(process.execPath, [seedEntry], { env: { ...env, SEED_USERNAME: formationUser, SEED_PASSWORD: formationPassword } });
if (seed2 !== 0) process.exit(seed2);

// 2. Start the built server and wait for /health.
const server = spawn(process.execPath, [serverEntry], { cwd: repoRoot, env, stdio: ["ignore", "inherit", "inherit"] });
let serverExited = false;
server.on("exit", () => (serverExited = true));
const deadline = Date.now() + 20_000;
let healthy = false;
while (Date.now() < deadline && !serverExited) {
  try {
    const res = await fetch(`http://${host}:${port}/health`);
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}
if (!healthy) {
  console.error("e2e: server did not become healthy");
  server.kill("SIGTERM");
  process.exit(1);
}

// 3. Playwright against vite preview (its /api proxy points at this server).
let code = 1;
try {
  code = await run("pnpm", ["--filter", "@caravan/web", "e2e"], {
    env: { ...process.env, CARAVAN_API_URL: `http://${host}:${port}`, E2E_FORMATION_USERNAME: formationUser, E2E_FORMATION_PASSWORD: formationPassword },
  });
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => {
    const t = setTimeout(() => {
      server.kill("SIGKILL");
      r();
    }, 5_000);
    server.on("exit", () => {
      clearTimeout(t);
      r();
    });
  });
}
process.exit(code);
