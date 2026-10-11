// Proves the resolver isolation rules actually fire. Lints the violation fixtures and
// asserts every line from the first statement onward errors, lints the allowed fixture and
// asserts it is clean, and checks the src glob covers every script extension.
import { ESLint } from "eslint";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_GLOB = "lint-fixtures/**/*.{ts,mts,cts,js,mjs,cjs}";

const { isolationRules } = await import(path.join(root, "eslint.config.js"));
const linter = new ESLint({
  cwd: root,
  overrideConfigFile: path.join(root, "eslint.config.js"),
  overrideConfig: [{ files: [FIXTURE_GLOB], rules: isolationRules }],
  ignorePatterns: ["!lint-fixtures/**"],
});

let failed = false;
const fail = (msg, detail) => {
  failed = true;
  console.error(`Resolver lint self-test FAILED: ${msg}`);
  if (detail !== undefined) console.error(detail);
};

// --- 1. violations.ts: every statement line must error --------------------------------
const violationsPath = "lint-fixtures/violations.ts";
const violationLines = readFileSync(path.join(root, violationsPath), "utf8").split("\n");
const FIRST_STATEMENT_LINE = 3; // lines 1-2 are the header comment
const expected = [];
for (let i = FIRST_STATEMENT_LINE; i <= violationLines.length; i++) {
  if (violationLines[i - 1].trim() !== "") expected.push(i);
}
const [violations] = await linter.lintFiles([violationsPath]);
const flagged = new Set(violations.messages.filter((m) => m.severity === 2).map((m) => m.line));
const missing = expected.filter((l) => !flagged.has(l));
if (missing.length) {
  fail(
    "these violation lines were not flagged:\n" + missing.map((l) => `  L${l}: ${violationLines[l - 1]}`).join("\n"),
  );
}

// --- 2. with.ts must error (parse error in module code, or the WithStatement rule) --------
const [withResult] = await linter.lintFiles(["lint-fixtures/with.ts"]);
if (!withResult.messages.some((m) => m.severity === 2 || m.fatal)) fail("`with` was not flagged in lint-fixtures/with.ts");

// --- 3. violations.mjs must error: the rules reach .mjs, not only .ts ---------------------
const [mjsResult] = await linter.lintFiles(["lint-fixtures/violations.mjs"]);
if (!mjsResult.messages.some((m) => m.severity === 2 && m.line === 2)) fail("Math.random() in a .mjs fixture was not flagged (rules must cover src/**/*.{ts,mts,cts,js,mjs,cjs})");

// --- 4. The real src glob must apply the isolation rules to every extension ---------------
const realLinter = new ESLint({ cwd: root, overrideConfigFile: path.join(root, "eslint.config.js") });
for (const ext of ["ts", "mts", "cts", "js", "mjs", "cjs"]) {
  const cfg = await realLinter.calculateConfigForFile(path.join(root, `src/probe.${ext}`));
  const rule = cfg?.rules?.["no-restricted-syntax"];
  if (!rule || rule[0] !== 2 && rule[0] !== "error") fail(`isolation rules do not apply to src/**/*.${ext}`);
}

// --- 5. allowed.ts must be clean ------------------------------------------------------------
const [allowed] = await linter.lintFiles(["lint-fixtures/allowed.ts"]);
const falsePositives = allowed.messages.filter((m) => m.severity === 2);
if (falsePositives.length) fail("allowed fixed-point idioms were flagged:", falsePositives.map((m) => `  L${m.line}: ${m.message}`).join("\n"));

if (failed) process.exit(1);
console.log(
  `Resolver lint self-test passed: ${expected.length} violation lines flagged (${flagged.size} distinct lines errored), ` +
    `with/mjs fixtures flagged, src glob covers ts/mts/cts/js/mjs/cjs, ${falsePositives.length} false positives in allowed.ts.`,
);
