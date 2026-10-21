#!/usr/bin/env node
// `pnpm e2e` — the web client's Playwright suite against the BUILT server (chunk 06).
// `pnpm e2e:hosting` (= `node scripts/e2e.mjs --hosting`) — the same suite against the built
// server in single-process hosting mode (final review S2): SERVE_WEB=1, the client served by the
// server itself, every API route under /api, no vite preview and no proxy in between. The
// hosting-only spec (e2e/hosting.spec.ts) runs in this mode only.
//
// Expects `pnpm build` to have run (apps/server/dist and apps/web/dist) and a MIGRATED database
// at E2E_DATABASE_URL (falls back to TEST_DATABASE_URL, then DATABASE_URL). Final review N8: pass
// the APP ROLE's URL (caravan_app) — what the shipped server runs as; `pnpm check` does.
//
// Steps: seed the authored parties and the run's fixture accounts (`seed.js --dev`: dev, a
// run-unique formation account and a run-unique trip account), build the client once more with
// VITE_ISO_DEBUG=1 into apps/web/dist-e2e (the specs aim through window.__isoDebug, which the
// shipped build does not carry), refuse to start if something already answers on E2E_PORT
// (final review N6), start the built server, put the formation account on the trail, run
// Playwright, stop the server. Exit code is Playwright's.
//
// Chunk 23: the server runs with CARAVAN_TEST_RESOLVER=double (and NODE_ENV=test — the flag is
// refused in production) so a committed encounter resolves predictably in-process.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { assertPortFree, loadDotEnv, repoRoot, stop, waitHealthy } from "./lib/env.mjs";

loadDotEnv();
const hosting = process.argv.includes("--hosting");
const label = hosting ? "e2e:hosting" : "e2e";
const serverEntry = path.join(repoRoot, "apps", "server", "dist", "index.js");
const seedEntry = path.join(repoRoot, "apps", "server", "dist", "seed.js");
const webDist = path.join(repoRoot, "apps", "web", "dist", "index.html");
for (const f of [serverEntry, seedEntry, webDist]) {
  if (!existsSync(f)) {
    console.error(`${label}: ${path.relative(repoRoot, f)} not found; run \`pnpm build\` first.`);
    process.exit(1);
  }
}

const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(`${label}: set E2E_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL) to a migrated database.`);
  process.exit(1);
}
const port = Number(process.env.E2E_PORT ?? (hosting ? 3918 : 3917));
const host = "127.0.0.1";
const e2eDist = path.join(repoRoot, "apps", "web", "dist-e2e");
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  PORT: String(port),
  HOST: host,
  NODE_ENV: "test",
  CARAVAN_TEST_RESOLVER: "double",
  // Chunk 30: the specs register many fresh accounts from one address; the limits have their own server tests.
  CARAVAN_RATE_LIMITS: process.env.CARAVAN_RATE_LIMITS ?? "off",
  // Explicit either way, so a SERVE_WEB in the caller's shell or .env cannot change the preview run.
  ...(hosting ? { SERVE_WEB: "1", WEB_DIST: e2eDist } : { SERVE_WEB: "0" }),
};

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: "inherit", ...opts });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

// 1. Seed (idempotent: the authored set is versioned, `dev` is left alone when it exists).
const seedCode = await run(process.execPath, [seedEntry, "--dev"], { env });
if (seedCode !== 0) process.exit(seedCode);
// 1b. Chunk 08: a run-unique account for the formation e2e (trip state is never reset, so a
// fresh account per run is the only way to start from "in town").
const stamp = Date.now().toString(36);
const formationUser = process.env.E2E_FORMATION_USERNAME ?? `e2e_formation_${stamp}`;
const formationPassword = process.env.E2E_FORMATION_PASSWORD ?? "e2epassword";
if ((await run(process.execPath, [seedEntry, "--dev"], { env: { ...env, SEED_USERNAME: formationUser, SEED_PASSWORD: formationPassword } })) !== 0) process.exit(1);
// 1c. Chunk 23: a run-unique account in town for the full-trip e2e (outfit → ride out → … → bank).
const tripUser = process.env.E2E_TRIP_USERNAME ?? `e2e_trip_${stamp}`;
const tripPassword = process.env.E2E_TRIP_PASSWORD ?? "e2epassword";
if ((await run(process.execPath, [seedEntry, "--dev"], { env: { ...env, SEED_USERNAME: tripUser, SEED_PASSWORD: tripPassword } })) !== 0) process.exit(1);

// 2. The e2e client build (before the server: in hosting mode the server serves it).
const built = await run("pnpm", ["--filter", "@caravan/web", "exec", "vite", "build", "--outDir", "dist-e2e", "--emptyOutDir", "--logLevel", "warn"], {
  env: { ...process.env, VITE_ISO_DEBUG: "1" },
});
if (built !== 0) {
  console.error(`${label}: the e2e client build failed`);
  process.exit(1);
}

// 3. Start the built server (refusing a port that is already taken) and wait for /health.
try {
  await assertPortFree(host, port, label);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
const server = spawn(process.execPath, [serverEntry], { cwd: repoRoot, env, stdio: ["ignore", "inherit", "inherit"] });
const base = `http://${host}:${port}`;
const api = hosting ? `${base}/api` : base;
if (!(await waitHealthy(`${api}/health`, server))) {
  console.error(`${label}: server did not become healthy at ${api}/health`);
  await stop(server);
  process.exit(1);
}

// 3b. Chunk 08 + 14 + 15: put the formation account on the trail through the real routes:
// pack (chunk 07) and ride out (chunk 15's POST …/trip/start). The spec starts at "search".
async function openTrip() {
  const post = (p, body, token) =>
    fetch(`${api}${p}`, {
      method: "POST",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const login = await post("/auth/login", { username: formationUser, password: formationPassword });
  if (!login.ok) throw new Error(`${label}: login for ${formationUser} failed: ${login.status}`);
  const { token } = await login.json();
  const me = await (await fetch(`${api}/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const caravan = me.caravans[0];
  const riders = caravan.units.filter((u) => u.unit_type_id === "desert.dust_rider").map((u) => u.id);
  const pack = await post(`/caravans/${caravan.id}/manifest`, { units: riders.slice(0, 2), traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 11 } }, token);
  if (pack.status !== 201) throw new Error(`${label}: pack failed: ${pack.status} ${await pack.text()}`);
  const start = await post(`/me/caravans/${caravan.id}/trip/start`, undefined, token);
  if (start.status !== 201) throw new Error(`${label}: ride out failed: ${start.status} ${await start.text()}`);
  console.log(`${label}: ${formationUser} packed and on the trail (caravan ${caravan.id}).`);
}

let code = 1;
try {
  await openTrip();
  // 4. Playwright. Preview mode: vite preview on E2E_WEB_PORT proxies /api to this server.
  // Hosting mode: the browser talks to the server directly (E2E_BASE_URL; no webServer).
  code = await run("pnpm", ["--filter", "@caravan/web", "e2e"], {
    env: {
      ...process.env,
      CARAVAN_API_URL: base,
      E2E_FORMATION_USERNAME: formationUser,
      E2E_FORMATION_PASSWORD: formationPassword,
      E2E_TRIP_USERNAME: tripUser,
      E2E_TRIP_PASSWORD: tripPassword,
      E2E_WEB_DIST: "dist-e2e",
      ...(hosting ? { E2E_BASE_URL: base, E2E_HOSTING: "1" } : { E2E_BASE_URL: "", E2E_HOSTING: "" }),
    },
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  code = 1;
} finally {
  await stop(server);
}
process.exit(code);
