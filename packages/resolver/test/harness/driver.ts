/**
 * Cross-process determinism driver (chunk 10; chunk 13 extends the corpus). Resolves every
 * fixture scenario and prints one `name sha256` line per scenario, so scripts/determinism.mjs
 * can run it in separate Node processes and compare. Lives outside src on purpose: it uses
 * node:crypto and stdout, which the resolver itself may not.
 */
import { createHash } from "node:crypto";
import { resolve } from "../../src/index.js";
import { clone, scenarios } from "../fixtures.js";

const runs = Number(process.argv[2] ?? "3");
const lines: string[] = [];
for (const { name, input } of scenarios()) {
  let first: string | null = null;
  for (let i = 0; i < runs; i++) {
    const text = JSON.stringify(resolve(clone(input)));
    const hash = createHash("sha256").update(text).digest("hex");
    if (first === null) first = hash;
    else if (hash !== first) {
      process.stdout.write(`DIVERGED ${name} run ${i}: ${hash} != ${first}\n`);
      process.exit(2);
    }
  }
  lines.push(`${name} ${first!}`);
}
process.stdout.write(lines.join("\n") + "\n");
