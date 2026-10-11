/**
 * Cross-process determinism driver (chunk 10; chunk 13 points it at the golden corpus).
 * Resolves every corpus scenario `runs` times in THIS process, checks the runs agree, and
 * prints one `name sha256` line per scenario — the sha256 of the scenario's GOLDEN TEXT
 * (test/golden.ts), so scripts/determinism.mjs can compare separate Node processes with each
 * other AND with the checked-in packages/resolver/golden files. Lives outside src on
 * purpose: it uses node:crypto and stdout, which the resolver itself may not.
 */
import { createHash } from "node:crypto";
import { resolve } from "../../src/index.js";
import { clone, scenarios } from "../fixtures.js";
import { goldenText } from "../golden.js";

const runs = Number(process.argv[2] ?? "3");
// The ORDER the corpus is resolved in (forward | reverse | rotate): separate processes use different ones.
const order = process.argv[3] ?? "forward";
const all = scenarios();
const ordered = order === "reverse" ? [...all].reverse() : order === "rotate" ? [...all.slice(Math.floor(all.length / 2)), ...all.slice(0, Math.floor(all.length / 2))] : all;
const lines: string[] = [];
for (const { name, input } of ordered) {
  let first: string | null = null;
  for (let i = 0; i < runs; i++) {
    const text = goldenText(name, resolve(clone(input)));
    const hash = createHash("sha256").update(text).digest("hex");
    if (first === null) first = hash;
    else if (hash !== first) {
      process.stdout.write(`DIVERGED ${name} run ${i}: ${hash} != ${first}\n`);
      process.exit(2);
    }
  }
  lines.push(`${name} ${first!}`);
}
lines.sort();
process.stdout.write(lines.join("\n") + "\n");
