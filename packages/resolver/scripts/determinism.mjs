#!/usr/bin/env node
// `pnpm --filter @caravan/resolver determinism` — the determinism harness the root
// scripts/determinism.mjs (chunk 21 CI gate) calls. Chunk 10 starts it; chunk 13 adds the
// golden corpus. Two steps:
//
//   1. In-process: vitest runs test/determinism.test.ts (every scenario 100× byte-identical,
//      every state field an integer every tick, no float in the output, input untouched).
//   2. Cross-process: test/harness/driver.ts is bundled once with esbuild (the root dev
//      dependency; nothing is added to the resolver) and run in PROCESS_COUNT separate Node
//      processes. Every process prints one sha256 per scenario; all must agree. The driver
//      also resolves each scenario several times within its own process.
//
// Exit code 1 on any disagreement. Zero resolver-side dependencies: runs with plain Node.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_COUNT = 3;
const RUNS_PER_PROCESS = 3;

// --- 1. in-process harness ------------------------------------------------------------
console.log("determinism: in-process harness (vitest test/determinism.test.ts)");
const vitest = spawnSync("pnpm", ["exec", "vitest", "run", "test/determinism.test.ts"], { cwd: pkgDir, stdio: "inherit" });
if (vitest.status !== 0) {
  console.error(`determinism: in-process harness FAILED (exit ${vitest.status ?? "signal"})`);
  process.exit(1);
}

// --- 2. cross-process -----------------------------------------------------------------
const outDir = mkdtempSync(path.join(tmpdir(), "caravan-resolver-determinism-"));
try {
  const bundle = path.join(outDir, "driver.mjs");
  await build({
    absWorkingDir: pkgDir,
    entryPoints: ["test/harness/driver.ts"],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "warning",
  });
  const outputs = [];
  for (let i = 0; i < PROCESS_COUNT; i++) {
    const run = spawnSync(process.execPath, [bundle, String(RUNS_PER_PROCESS)], { cwd: outDir, encoding: "utf8" });
    if (run.status !== 0) {
      console.error(`determinism: driver process ${i} FAILED (exit ${run.status ?? "signal"})\n${run.stdout}${run.stderr}`);
      process.exit(1);
    }
    outputs.push(run.stdout.trim());
  }
  const [first, ...rest] = outputs;
  const mismatch = rest.findIndex((o) => o !== first);
  if (mismatch >= 0) {
    console.error(`determinism: process ${mismatch + 1} disagrees with process 0:\n--- 0 ---\n${first}\n--- ${mismatch + 1} ---\n${rest[mismatch]}`);
    process.exit(1);
  }
  const scenarioCount = first.split("\n").filter(Boolean).length;
  console.log(`determinism: ${PROCESS_COUNT} processes × ${RUNS_PER_PROCESS} runs agree on ${scenarioCount} scenario(s):`);
  for (const line of first.split("\n")) console.log(`  ${line}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
