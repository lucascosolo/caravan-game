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

// 2b. Chunk 08 + 14: put the formation account on the trail. Packing is a town action
// (chunk 17's screen; chunk 07's route exists), and the trip row is chunk 15's to open —
// chunk 14's `createTrip` service is the seam its own tests use, so this mirrors its SQL
// (one open trip per caravan, bound to the open manifest). The spec then starts at
// "search for parties".
async function openTrip() {
  const api = `http://${host}:${port}`;
  const post = (path, body, token) =>
    fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const login = await post("/auth/login", { username: formationUser, password: formationPassword });
  if (!login.ok) throw new Error(`e2e: login for ${formationUser} failed: ${login.status}`);
  const { token } = await login.json();
  const me = await (await fetch(`${api}/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const caravan = me.caravans[0];
  const riders = caravan.units.filter((u) => u.unit_type_id === "desert.dust_rider").map((u) => u.id);
  const pack = await post(`/caravans/${caravan.id}/manifest`, { units: riders.slice(0, 2), traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 20 } }, token);
  if (pack.status !== 201) throw new Error(`e2e: pack failed: ${pack.status} ${await pack.text()}`);
  const { manifest } = await pack.json();
  const { createRequire } = await import("node:module");
  const require = createRequire(path.join(repoRoot, "apps", "server", "package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("INSERT INTO trip (caravan_id, manifest_id) VALUES ($1, $2)", [caravan.id, manifest.id]);
  } finally {
    await client.end();
  }
  console.log(`e2e: ${formationUser} packed and on the trail (caravan ${caravan.id}).`);
}
try {
  await openTrip();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  server.kill("SIGTERM");
  process.exit(1);
}

// 3. Playwright against vite preview (its /api proxy points at this server). The specs aim
// drops through `window.__isoDebug`, which a production build does not carry (chunk 08 QA
// N5), so the client is built once more with VITE_ISO_DEBUG=1 into apps/web/dist-e2e and
// the preview serves that. apps/web/dist (what ships) stays hook-free.
let code = 1;
try {
  const built = await run("pnpm", ["--filter", "@caravan/web", "exec", "vite", "build", "--outDir", "dist-e2e", "--emptyOutDir", "--logLevel", "warn"], {
    env: { ...process.env, VITE_ISO_DEBUG: "1" },
  });
  if (built !== 0) throw new Error("e2e: the e2e client build failed");
  code = await run("pnpm", ["--filter", "@caravan/web", "e2e"], {
    env: { ...process.env, CARAVAN_API_URL: `http://${host}:${port}`, E2E_FORMATION_USERNAME: formationUser, E2E_FORMATION_PASSWORD: formationPassword, E2E_WEB_DIST: "dist-e2e" },
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
