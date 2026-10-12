#!/usr/bin/env node
// `pnpm smoke` — smoke-run the BUILT server (chunk 21; final review S2 / N8). Two checks against a
// migrated database at SMOKE_DATABASE_URL (falls back to TEST_DATABASE_URL, then DATABASE_URL).
// Pass the APP ROLE's URL (caravan_app): that is what the shipped server runs as; `pnpm check` does.
//
//   1. NODE_ENV=production with a repo-default database password must REFUSE TO START (exit
//      non-zero, saying so). Skipped, with a note, when the URL's password is not a repo default.
//   2. The single-process hosting mode (SERVE_WEB=1, the built client in apps/web/dist) starts
//      and answers GET /health, GET /api/health and GET / (the client), then shuts down cleanly.
//      NODE_ENV=test here, because step 1 proves production refuses the test database's password.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { assertPortFree, loadDotEnv, repoRoot, stop, waitHealthy } from "./lib/env.mjs";

loadDotEnv();
const entry = path.join(repoRoot, "apps", "server", "dist", "index.js");
const webIndex = path.join(repoRoot, "apps", "web", "dist", "index.html");
for (const f of [entry, webIndex]) {
  if (!existsSync(f)) {
    console.error(`smoke: ${path.relative(repoRoot, f)} not found; run \`pnpm build\` first.`);
    process.exit(1);
  }
}
const databaseUrl = process.env.SMOKE_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("smoke: set SMOKE_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL).");
  process.exit(1);
}
const port = Number(process.env.SMOKE_PORT ?? 3916);
const host = "127.0.0.1";
const base = { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), HOST: host };
delete base.CARAVAN_TEST_RESOLVER;
delete base.CARAVAN_RATE_LIMITS;

function start(env) {
  const child = spawn(process.execPath, [entry], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  return { child, output: () => output };
}

function fail(msg, out) {
  console.error(`smoke: FAILED — ${msg}`);
  if (out) console.error("--- server output ---\n" + out);
  process.exit(1);
}

await assertPortFree(host, port, "smoke").catch((err) => fail(err.message));

// 1. Production refuses a repo-default password.
const password = decodeURIComponent(new URL(databaseUrl).password);
if (["caravan", "caravan_app"].includes(password)) {
  const prod = start({ ...base, NODE_ENV: "production" });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), 15_000);
    prod.child.on("exit", (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  if (code === "timeout") {
    await stop(prod.child);
    fail("NODE_ENV=production started with a repo-default database password (it must refuse)", prod.output());
  }
  if (code === 0 || !/default password/.test(prod.output())) fail(`NODE_ENV=production exited ${code} without the default-password refusal`, prod.output());
  console.log("smoke: NODE_ENV=production refused to start with the repo-default database password (as it must).");
} else {
  console.log("smoke: the database password is not a repo default; the production-refusal check is skipped.");
}

// 2. Single-process hosting boots and answers.
const hosted = start({ ...base, NODE_ENV: "test", SERVE_WEB: "1" });
const healthy = await waitHealthy(`http://${host}:${port}/health`, hosted.child);
let problem = healthy ? null : "the built server did not answer GET /health with {ok:true}";
if (!problem) {
  const apiHealth = await fetch(`http://${host}:${port}/api/health`).then((r) => r.json(), () => null);
  if (!apiHealth || apiHealth.ok !== true) problem = "GET /api/health did not answer {ok:true}";
}
if (!problem) {
  const root = await fetch(`http://${host}:${port}/`).catch(() => null);
  const text = root ? await root.text() : "";
  if (!root || root.status !== 200 || !/text\/html/.test(root.headers.get("content-type") ?? "") || !text.includes('id="root"')) problem = "GET / did not serve the client's index.html";
  else if (!root.headers.get("content-security-policy")) problem = "GET / carried no Content-Security-Policy";
}
await stop(hosted.child);
if (problem) fail(problem, hosted.output());
console.log(`smoke: built server (SERVE_WEB=1) answered /health, /api/health and / on ${host}:${port}; shut down cleanly.`);
