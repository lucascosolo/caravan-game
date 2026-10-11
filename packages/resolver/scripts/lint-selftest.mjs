// Proves the resolver isolation rules actually fire: lints the violation fixture and
// asserts every expected line errors, then lints the allowed fixture and asserts clean.
import { ESLint } from "eslint";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_VIOLATION_LINES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

// Fixtures are ignored by the main config; lint them explicitly with the src rule set.
const base = (await import(path.join(root, "eslint.config.js"))).default;
const srcRules = base.find((c) => c.files && c.files.includes("src/**/*.ts")).rules;
const linter = new ESLint({
  cwd: root,
  overrideConfigFile: path.join(root, "eslint.config.js"),
  overrideConfig: [{ files: ["lint-fixtures/**/*.ts"], rules: srcRules }],
  ignorePatterns: ["!lint-fixtures/**"],
});

const [violations] = await linter.lintFiles(["lint-fixtures/violations.ts"]);
const flagged = new Set(violations.messages.filter((m) => m.severity === 2).map((m) => m.line));
const missing = EXPECTED_VIOLATION_LINES.filter((l) => !flagged.has(l));
if (missing.length) {
  console.error("Resolver lint self-test FAILED: these violation lines were not flagged:", missing);
  console.error(violations.messages);
  process.exit(1);
}

const [allowed] = await linter.lintFiles(["lint-fixtures/allowed.ts"]);
const falsePositives = allowed.messages.filter((m) => m.severity === 2);
if (falsePositives.length) {
  console.error("Resolver lint self-test FAILED: allowed fixed-point idioms were flagged:");
  console.error(falsePositives);
  process.exit(1);
}
console.log(`Resolver lint self-test passed: ${EXPECTED_VIOLATION_LINES.length} violations flagged, ${allowed.messages.length} false positives.`);
