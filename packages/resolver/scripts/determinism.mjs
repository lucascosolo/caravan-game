#!/usr/bin/env node
// `pnpm --filter @caravan/resolver determinism` — the determinism harness the root
// scripts/determinism.mjs (chunk 21 CI gate) calls. Chunk 10 started it; chunk 13 completed it
// with the golden corpus (packages/resolver/golden, one <scenario>.golden.json per fight).
// Three steps:
//
//   1. In-process: vitest runs test/determinism.test.ts — every corpus scenario 100× byte-
//      identical, every scenario equal to its golden file, the corpus ≥ 50 fights with the
//      coverage chunk 13 lists, every state field an integer every tick, no float in the
//      output, input untouched.
//   2. Cross-process: test/harness/driver.ts is bundled once with esbuild (the root dev
//      dependency; nothing is added to the resolver) and run in PROCESS_COUNT separate Node
//      processes — each resolving the corpus in a DIFFERENT ORDER (forward, reversed, rotated)
//      and with different V8 heap settings, so JIT warm-up order and allocation pattern vary.
//      Every process prints one sha256 of the golden text per scenario (sorted by name); all
//      must agree with each other.
//   3. Against the goldens: every process hash must equal the sha256 of the checked-in
//      golden file, and every golden file must belong to a scenario.
//
// Exit code 1 on any disagreement. The root gate separately refuses golden-file changes that
// do not come with a RESOLVER_VERSION bump. Zero resolver-side dependencies.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goldenDir = path.join(pkgDir, "golden");
const GOLDEN_SUFFIX = ".golden.json";
const PROCESS_FLAGS = [[], ["--max-old-space-size=256"], ["--max-semi-space-size=1", "--stack-size=2000"]];
const PROCESS_ORDER = ["forward", "reverse", "rotate"];
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
let first;
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
  for (let i = 0; i < PROCESS_FLAGS.length; i++) {
    const run = spawnSync(process.execPath, [...PROCESS_FLAGS[i], bundle, String(RUNS_PER_PROCESS), PROCESS_ORDER[i]], { cwd: outDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (run.status !== 0) {
      console.error(`determinism: driver process ${i} FAILED (exit ${run.status ?? "signal"})\n${run.stdout}${run.stderr}`);
      process.exit(1);
    }
    outputs.push(run.stdout.trim());
  }
  first = outputs[0];
  const mismatch = outputs.slice(1).findIndex((o) => o !== first);
  if (mismatch >= 0) {
    console.error(`determinism: process ${mismatch + 1} disagrees with process 0:\n--- 0 ---\n${first}\n--- ${mismatch + 1} ---\n${outputs[mismatch + 1]}`);
    process.exit(1);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// --- 3. against the checked-in goldens --------------------------------------------------
const hashes = new Map(first.split("\n").filter(Boolean).map((l) => l.split(" ")));
const files = readdirSync(goldenDir).filter((f) => f.endsWith(GOLDEN_SUFFIX));
const bad = [];
for (const [name, hash] of hashes) {
  const file = path.join(goldenDir, `${name}${GOLDEN_SUFFIX}`);
  let want;
  try {
    want = createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
  } catch {
    bad.push(`${name}: no golden file`);
    continue;
  }
  if (want !== hash) bad.push(`${name}: process output ${hash.slice(0, 12)} ≠ golden ${want.slice(0, 12)}`);
}
for (const f of files) if (!hashes.has(f.slice(0, -GOLDEN_SUFFIX.length))) bad.push(`${f}: golden file with no scenario`);
if (bad.length) {
  console.error(`determinism: the separate processes disagree with the golden corpus:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`determinism: ${PROCESS_FLAGS.length} processes (orders ${PROCESS_ORDER.join(", ")}) × ${RUNS_PER_PROCESS} runs agree with each other and with ${files.length} golden logs:`);
for (const [name, hash] of hashes) console.log(`  ${name} ${hash}`);
