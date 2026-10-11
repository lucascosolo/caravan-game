#!/usr/bin/env node
// Determinism harness gate for CI (chunk 21). The harness itself is chunk 13's deliverable.
//
// What this does, in order:
//   1. If @caravan/resolver has a `determinism` script, run it and propagate its exit code.
//      Until chunk 13 lands there is no such script, and this step reports "pending" and
//      exits 0 so the rest of CI keeps running.
//   2. Golden-log protection (QA-13 S5; the rule is scripts/golden-gate.mjs, self-tested by
//      scripts/golden-gate.test.mjs, which runs first). If a golden corpus exists (GOLDEN_DIR
//      below) and a base ref is known (pull requests: GITHUB_BASE_REF; pushes:
//      DETERMINISM_BASE_SHA from the workflow; locally: DETERMINISM_BASE_REF), a changed,
//      deleted or renamed golden file fails the run UNLESS RESOLVER_VERSION (VERSION_FILE)
//      INCREASED as an integer over the range — the `[resolver-bump]` tag covers only ADDED
//      fixtures — and every added or changed golden carries the new version. A silently changed
//      replay, or two behaviours under one version, is exactly what GUARDRAILS §1 bans.
//
// Chunk 13 only has to (a) add `"determinism": "..."` to packages/resolver/package.json and
// (b) check golden logs into packages/resolver/golden/. Nothing here needs to change.
// Mind the root .gitignore: `*.log` is ignored, so name golden files e.g. `<case>.golden.json`
// (or add `!packages/resolver/golden/**` to .gitignore) or they will never be committed.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUMP_TAG, goldenGateVerdict } from "./golden-gate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolverDir = path.join(repoRoot, "packages", "resolver");
const GOLDEN_DIR = "packages/resolver/golden"; // repo-relative; chunk 13 checks logs in here
const VERSION_FILE = "packages/resolver/src/version.ts"; // `export const RESOLVER_VERSION = N;`

const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

// --- 0. The gate's own self-test (QA-13 S5) ----------------------------------------------
{
  const self = spawnSync(process.execPath, ["--test", path.join(repoRoot, "scripts", "golden-gate.test.mjs")], { cwd: repoRoot, stdio: "inherit", timeout: 60_000 });
  if (self.status !== 0) {
    console.error(`determinism: golden-gate self-test FAILED (exit ${self.status ?? "signal"})`);
    process.exit(1);
  }
}

// --- 1. Run the harness if it exists ------------------------------------------------------
const pkg = JSON.parse(readFileSync(path.join(resolverDir, "package.json"), "utf8"));
if (pkg.scripts?.determinism) {
  console.log("determinism: running `pnpm --filter @caravan/resolver run determinism`");
  const run = spawnSync("pnpm", ["--filter", "@caravan/resolver", "run", "determinism"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (run.status !== 0) {
    console.error(`determinism: harness FAILED (exit ${run.status ?? "signal"})`);
    process.exit(run.status ?? 1);
  }
  console.log("determinism: harness passed");
} else {
  console.log("determinism: PENDING — @caravan/resolver has no `determinism` script yet (chunk 13). Skipping harness run.");
}

// --- 2. Golden-log change protection ------------------------------------------------------
const goldenAbs = path.join(repoRoot, GOLDEN_DIR);
if (!existsSync(goldenAbs)) {
  console.log(`determinism: no golden corpus at ${GOLDEN_DIR} yet; golden-change check skipped.`);
  process.exit(0);
}

function resolveBase() {
  if (process.env.DETERMINISM_BASE_SHA) return process.env.DETERMINISM_BASE_SHA;
  if (process.env.DETERMINISM_BASE_REF) return process.env.DETERMINISM_BASE_REF;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return null;
}

const base = resolveBase();
if (!base) {
  console.log("determinism: no base ref (set DETERMINISM_BASE_REF locally); golden-change check skipped.");
  process.exit(0);
}
if (/^0+$/.test(base)) {
  console.log("determinism: base is the null sha (branch creation); golden-change check skipped.");
  process.exit(0);
}

let mergeBase;
try {
  mergeBase = git("merge-base", base, "HEAD");
} catch (err) {
  console.error(`determinism: cannot compute merge-base against '${base}': ${err.message}`);
  console.error("determinism: in CI make sure the checkout has enough history (fetch-depth: 0).");
  process.exit(1);
}

const changedGolden = git("diff", "--name-status", `${mergeBase}..HEAD`, "--", GOLDEN_DIR)
  .split("\n")
  .filter(Boolean);
if (changedGolden.length === 0) {
  console.log(`determinism: golden corpus unchanged since ${mergeBase.slice(0, 10)}.`);
  process.exit(0);
}

const show = (rev, file) => {
  try {
    return git("show", `${rev}:${file}`);
  } catch {
    return null;
  }
};
const changes = changedGolden.map((line) => {
  const parts = line.split("\t");
  const status = parts[0];
  const file = parts[parts.length - 1];
  return { status, path: file, text: status.startsWith("D") ? null : show("HEAD", file) };
});
const commitMessages = git("log", "--format=%B", `${mergeBase}..HEAD`);
const verdict = goldenGateVerdict({
  changes,
  baseVersionText: show(mergeBase, VERSION_FILE),
  headVersionText: show("HEAD", VERSION_FILE),
  tagged: commitMessages.includes(BUMP_TAG),
});

console.log(`determinism: ${changedGolden.length} golden file(s) changed since ${mergeBase.slice(0, 10)}:`);
for (const line of changedGolden) console.log(`  ${line}`);

if (verdict.ok) {
  console.log(`determinism: ${verdict.summary}.`);
  process.exit(0);
}

console.error(
  `determinism: FAILED — golden logs changed without a valid resolver version bump:\n  ${verdict.reasons.join("\n  ")}\n` +
    `  A changed replay must be an explicit decision (GUARDRAILS §1): increase RESOLVER_VERSION in ${VERSION_FILE}\n` +
    `  in the same change and regenerate the goldens (UPDATE_GOLDEN=1). '${BUMP_TAG}' covers only new fixtures.`,
);
process.exit(1);
