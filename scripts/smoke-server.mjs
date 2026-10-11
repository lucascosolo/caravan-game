#!/usr/bin/env node
// Smoke-run the built server (chunk 21): proves `pnpm build` output actually starts and
// answers GET /health against a migrated database, then shuts it down.
//
// Usage: SMOKE_DATABASE_URL=postgres://... node scripts/smoke-server.mjs
// Falls back to TEST_DATABASE_URL, then DATABASE_URL. The database must already be migrated
// (`DATABASE_URL=... pnpm db:migrate`); this script does not touch the schema.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "apps", "server", "dist", "index.js");
if (!existsSync(entry)) {
  console.error(`smoke: ${path.relative(repoRoot, entry)} not found; run \`pnpm build\` first.`);
  process.exit(1);
}

const databaseUrl = process.env.SMOKE_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("smoke: set SMOKE_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL).");
  process.exit(1);
}
const port = Number(process.env.SMOKE_PORT ?? 3917);
const host = "127.0.0.1";
const TIMEOUT_MS = 20_000;

const child = spawn(process.execPath, [entry], {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), HOST: host, NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
let exited = null;
child.on("exit", (code, signal) => (exited = { code, signal }));

const deadline = Date.now() + TIMEOUT_MS;
let ok = false;
while (Date.now() < deadline && !exited) {
  try {
    const res = await fetch(`http://${host}:${port}/health`);
    const body = await res.json();
    if (res.ok && body && body.ok === true) {
      ok = true;
      break;
    }
    console.error(`smoke: /health returned ${res.status} ${JSON.stringify(body)}`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

child.kill("SIGTERM");
await new Promise((r) => {
  const t = setTimeout(() => {
    child.kill("SIGKILL");
    r();
  }, 3000);
  child.on("exit", () => {
    clearTimeout(t);
    r();
  });
});

if (!ok) {
  console.error("smoke: FAILED — built server did not answer GET /health with {ok:true}.");
  if (exited) console.error(`smoke: process exited early (code ${exited.code}, signal ${exited.signal}).`);
  console.error("--- server output ---\n" + output);
  process.exit(1);
}
console.log(`smoke: built server answered GET /health on ${host}:${port}; shut down cleanly.`);
