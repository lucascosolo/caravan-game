/**
 * Chunk 13 — the golden-log text of one corpus fight. A pure function of the resolver's
 * output: the outcome and end-of-fight summaries, then the stored replay (LOG_FORMAT,
 * src/replay.ts) with one event row per line so a golden diff reads event by event.
 *
 * Checked in under packages/resolver/golden/<scenario>.golden.json (NOT *.log: the root
 * .gitignore drops those). test/determinism.test.ts compares every scenario with its file;
 * scripts/determinism.mjs compares the sha256 printed by separate Node processes with the
 * same files; and the root scripts/determinism.mjs (CI) refuses any change to them that does
 * not come with a RESOLVER_VERSION bump or a `[resolver-bump]` commit.
 *
 * To regenerate after an INTENDED resolver change: bump RESOLVER_VERSION, then
 *   UPDATE_GOLDEN=1 pnpm --filter @caravan/resolver exec vitest run test/determinism.test.ts
 */
import { encodeReplay, type ResolveOutput } from "../src/index.js";

export const GOLDEN_SUFFIX = ".golden.json";

export function goldenText(name: string, out: ResolveOutput): string {
  const replay = encodeReplay(out);
  const { events, ...header } = replay;
  const lines: string[] = [];
  lines.push("{");
  lines.push(`"scenario": ${JSON.stringify(name)},`);
  lines.push(`"resolverVersion": ${out.resolverVersion},`);
  lines.push(`"outcome": ${JSON.stringify(out.outcome)},`);
  lines.push(`"ticks": ${out.ticks},`);
  lines.push(`"units": [\n${out.units.map((u) => JSON.stringify(u)).join(",\n")}\n],`);
  lines.push(`"fences": [${out.fences.length ? `\n${out.fences.map((f) => JSON.stringify(f)).join(",\n")}\n` : ""}],`);
  lines.push(`"traps": [${out.traps.length ? `\n${out.traps.map((t) => JSON.stringify(t)).join(",\n")}\n` : ""}],`);
  const headerJson = JSON.stringify(header);
  // The replay object with its events spliced back in, one row per line, in the encoder's key order.
  lines.push(`"replay": ${headerJson.slice(0, -1)},"events":[\n${events.map((r) => JSON.stringify(r)).join(",\n")}\n]}`);
  lines.push("}");
  return lines.join("\n") + "\n";
}
