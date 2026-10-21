#!/usr/bin/env node
// `pnpm check` — every gate, in order, exactly what CI runs (final review N1). The CI workflow
// (.github/workflows/ci.yml) is `pnpm check` plus the Postgres service and the browser install.
//
//   1  typecheck        tsc --noEmit in every package
//   2  lint             resolver isolation rules + their self-test
//   3  test:boundary    resolver dependency boundary
//   4  test             every package's vitest (server against TEST_DATABASE_URL, which it resets)
//   5  determinism      golden gate self-test, 100× in-process, 3 processes vs the goldens
//   6  perf:resolver    pinned work counters + relative CPU budget
//   7  build            server dist + web dist (+ the bundle check)
//   8  migrate          the test database (owner URL), then db/roles.sql
//   9  smoke            the built server AS caravan_app (N8): production refuses the test password; SERVE_WEB boots
//  10  e2e              Playwright via vite preview, the built server AS caravan_app (N8)
//  11  e2e:hosting      Playwright against the built server in single-process hosting mode (S2), AS caravan_app
//
// Needs TEST_DATABASE_URL (the OWNER role on a database whose name contains "test"; default
// postgres://caravan:caravan@localhost:5432/caravan_test), Playwright's Chromium
// (`pnpm --filter @caravan/web exec playwright install chromium`), and the repo's .env if you use one.
// `--from <step>` resumes at a step (by name), e.g. after fixing an e2e failure: `pnpm check -- --from e2e`.
import { spawn } from "node:child_process";
import { appRoleUrl, loadDotEnv, repoRoot } from "./lib/env.mjs";

loadDotEnv();
const ownerUrl = process.env.TEST_DATABASE_URL ?? "postgres://caravan:caravan@localhost:5432/caravan_test";
if (!/test/i.test(new URL(ownerUrl).pathname)) {
  console.error(`check: TEST_DATABASE_URL must name a database containing 'test' (the suite resets it); got ${ownerUrl}`);
  process.exit(1);
}
const appUrl = appRoleUrl(ownerUrl);
const env = { ...process.env, TEST_DATABASE_URL: ownerUrl };

const steps = [
  ["typecheck", ["pnpm", "typecheck"]],
  ["lint", ["pnpm", "lint"]],
  ["test:boundary", ["pnpm", "test:boundary"]],
  ["test", ["pnpm", "test"]],
  ["determinism", ["pnpm", "determinism"]],
  ["perf:resolver", ["pnpm", "perf:resolver"]],
  ["build", ["pnpm", "build"]],
  // PHASE-2 §26: art coverage, size/anchor rules and the payload budget (reads apps/web/dist, so after build).
  ["art:check", ["pnpm", "art:check"]],
  ["migrate", ["node", "apps/server/dist/db/migrate.js", "up"], { MIGRATE_DATABASE_URL: ownerUrl, DATABASE_URL: ownerUrl }],
  ["smoke", ["node", "scripts/smoke-server.mjs"], { SMOKE_DATABASE_URL: appUrl }],
  ["e2e", ["node", "scripts/e2e.mjs"], { E2E_DATABASE_URL: appUrl }],
  ["e2e:hosting", ["node", "scripts/e2e.mjs", "--hosting"], { E2E_DATABASE_URL: appUrl }],
];

const fromIdx = process.argv.indexOf("--from");
const from = fromIdx >= 0 ? process.argv[fromIdx + 1] : undefined;
let start = 0;
if (from !== undefined) {
  start = steps.findIndex(([name]) => name === from);
  if (start < 0) {
    console.error(`check: unknown step '${from}'; steps: ${steps.map(([n]) => n).join(", ")}`);
    process.exit(2);
  }
}

function run([cmd, ...args], extra) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: "inherit", env: { ...env, ...extra } });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const t0 = Date.now();
const done = [];
for (const [name, cmd, extra = {}] of steps.slice(start)) {
  const s = Date.now();
  console.log(`\n=== check: ${name} — ${cmd.join(" ")} ===`);
  const code = await run(cmd, extra);
  const secs = ((Date.now() - s) / 1000).toFixed(0);
  if (code !== 0) {
    console.error(`\n=== check: FAILED at ${name} (exit ${code}, ${secs} s). Passed: ${done.join(", ") || "none"}. Resume with: pnpm check -- --from ${name} ===`);
    process.exit(code);
  }
  done.push(`${name} (${secs} s)`);
}
console.log(`\n=== check: all ${done.length} steps passed in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${done.join(", ")} ===`);
