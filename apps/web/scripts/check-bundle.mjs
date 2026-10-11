// Chunk 22: the client NEVER runs the simulation (AGENTS.md, GUARDRAILS §1: "the tick log IS
// the replay; nothing is ever re-simulated for playback"). The replay player reads stored
// logs with the resolver package's REPLAY READER, which imports only fixed-point helpers and
// battlefield constants. This check runs after `vite build` and reads the (hidden) source
// maps: if any module of packages/resolver/src other than the reader and what it needs is
// in a client chunk — tick.ts, combat.ts, resolve.ts, path.ts, … — the build fails.
//
//   node scripts/check-bundle.mjs [distDir]      (default: apps/web/dist)
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, "..", "dist"));
const assets = path.join(dist, "assets");

/** The resolver modules a client bundle may contain: the replay reader and its two value imports. */
const ALLOWED = new Set(["fixed.ts", "battlefield.ts", "replay.ts"]);

let maps;
try {
  maps = readdirSync(assets).filter((f) => f.endsWith(".js.map"));
} catch {
  console.error(`check-bundle: no ${assets} — run vite build first`);
  process.exit(1);
}
if (maps.length === 0) {
  console.error("check-bundle: no source maps in the build (vite.config.ts must keep build.sourcemap)");
  process.exit(1);
}

const seen = new Set();
const bad = [];
for (const f of maps) {
  const { sources = [] } = JSON.parse(readFileSync(path.join(assets, f), "utf8"));
  for (const s of sources) {
    const m = /packages\/resolver\/src\/(.+)$/.exec(s.replace(/\\/g, "/"));
    if (!m) continue;
    seen.add(m[1]);
    if (!ALLOWED.has(m[1])) bad.push(`${f}: packages/resolver/src/${m[1]}`);
  }
}
if (bad.length > 0) {
  console.error("check-bundle: the client bundle contains simulation code (the client must only READ replays):");
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
if (!seen.has("replay.ts")) {
  console.error("check-bundle: the replay reader (packages/resolver/src/replay.ts) is not in the bundle — has the replay player been dropped?");
  process.exit(1);
}
console.log(`check-bundle: ok — resolver modules in the client: ${[...seen].sort().join(", ")} (reader only, no simulation)`);
