#!/usr/bin/env node
// `pnpm build` — produce runnable server output in apps/server/dist (chunk 21).
//
// Why a bundler rather than plain `tsc` emit: workspace packages (@caravan/content, later
// @caravan/resolver) export their TypeScript sources directly, so emitted JS that still
// says `import "@caravan/content"` is not runnable by Node. esbuild inlines the workspace
// packages and leaves real npm dependencies (fastify, pg, ...) external, so they resolve
// from apps/server/node_modules at runtime exactly as in dev.
//
// Output mirrors the source tree at the same depth (src/db/migrate.ts -> dist/db/migrate.js).
// That is deliberate: apps/server/src/db/migrate.ts finds its SQL files via `import.meta.url`
// + "../../migrations", and dist/db/migrate.js resolves that to the same apps/server/migrations
// directory. Keep dist/ a sibling of src/ or that breaks (scripts/smoke-server.mjs and the CI
// migrate step exercise it).
//
// Run the result with `pnpm start` (= node apps/server/dist/index.js).
import { build } from "esbuild";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(repoRoot, "apps", "server");
const outDir = path.join(serverDir, "dist");

// Entry points that must be runnable on their own in a deployed environment. Each is
// included only if it exists, so later chunks can add or rename without touching this file.
const CANDIDATE_ENTRIES = [
  "src/index.ts", // HTTP server
  "src/db/migrate.ts", // `node dist/db/migrate.js up|down|reset|status`
  "src/seed.ts", // dev/staging seed
  "src/worker.ts", // job-queue worker, if chunk 02 adds one as a separate process
];

const pkg = JSON.parse(readFileSync(path.join(serverDir, "package.json"), "utf8"));
// Bundle workspace packages, keep everything installed from npm external.
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith("@caravan/"));

const entryPoints = CANDIDATE_ENTRIES.filter((rel) => existsSync(path.join(serverDir, rel)));
if (entryPoints.length === 0) {
  console.error("build: no server entry points found under apps/server/src");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

const result = await build({
  absWorkingDir: serverDir,
  entryPoints,
  outdir: outDir,
  outbase: "src", // src/x.ts → dist/x.js, same depth as src/ (see header)
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "warning",
  external,
  // Workspace packages are resolved through node_modules symlinks; esbuild follows them.
  preserveSymlinks: false,
  metafile: true,
});

const outputs = Object.keys(result.metafile.outputs).filter((f) => f.endsWith(".js"));
console.log(`build: wrote ${outputs.length} bundle(s) to ${path.relative(repoRoot, outDir)}`);
for (const f of outputs) console.log(`  ${f}`);
console.log(`build: external (resolved from apps/server/node_modules at runtime): ${external.join(", ") || "none"}`);
