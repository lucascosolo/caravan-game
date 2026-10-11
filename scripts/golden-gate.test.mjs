// Self-test of the golden-log gate (QA-13 S5): fixture diffs → refused / accepted.
// Run: node --test scripts/golden-gate.test.mjs  (scripts/determinism.mjs runs it first).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUMP_TAG, goldenGateVerdict, parseResolverVersion } from "./golden-gate.mjs";

const versionFile = (n, comment = "") => `/**\n * history${comment}\n */\nexport const RESOLVER_VERSION = ${n};\n`;
const golden = (v) => `{\n"scenario": "x",\n"resolverVersion": ${v},\n"outcome": {}\n}\n`;
const G = (name) => `packages/resolver/golden/${name}.golden.json`;

test("parses RESOLVER_VERSION as an integer and ignores comments", () => {
  assert.equal(parseResolverVersion(versionFile(7)), 7);
  assert.equal(parseResolverVersion("// export const RESOLVER_VERSION = 9;\nexport const RESOLVER_VERSION = 8;"), 8);
  assert.equal(parseResolverVersion("const X = 1;"), null);
});

test("no golden change: accepted", () => {
  assert.equal(goldenGateVerdict({ changes: [], baseVersionText: versionFile(7), headVersionText: versionFile(7), tagged: false }).ok, true);
});

test("REFUSED: a modified golden with no bump", () => {
  const v = goldenGateVerdict({ changes: [{ status: "M", path: G("a"), text: golden(7) }], baseVersionText: versionFile(7), headVersionText: versionFile(7), tagged: false });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join("\n"), /not an integer increase/);
});

test("REFUSED: a modified golden with only the [resolver-bump] tag (the QA-13 S5 hole)", () => {
  const v = goldenGateVerdict({ changes: [{ status: "M", path: G("a"), text: golden(7) }], baseVersionText: versionFile(7), headVersionText: versionFile(7), tagged: true });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join("\n"), new RegExp(`covers only NEW fixtures`));
});

test("REFUSED: a comment edit next to RESOLVER_VERSION is not a bump", () => {
  const v = goldenGateVerdict({ changes: [{ status: "M", path: G("a"), text: golden(7) }], baseVersionText: versionFile(7), headVersionText: versionFile(7, " (edited)"), tagged: false });
  assert.equal(v.ok, false);
});

test("REFUSED: a decrement is not a bump", () => {
  const v = goldenGateVerdict({ changes: [{ status: "M", path: G("a"), text: golden(6) }], baseVersionText: versionFile(7), headVersionText: versionFile(6), tagged: false });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join("\n"), /7 → 6/);
});

test("REFUSED: a bump, but a changed golden still says the old version", () => {
  const v = goldenGateVerdict({
    changes: [{ status: "M", path: G("a"), text: golden(8) }, { status: "M", path: G("b"), text: golden(7) }],
    baseVersionText: versionFile(7),
    headVersionText: versionFile(8),
    tagged: false,
  });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join("\n"), /golden\/b\.golden\.json: carries resolverVersion 7, but HEAD's RESOLVER_VERSION is 8/);
});

test("REFUSED: a deleted or renamed golden without a bump, tagged or not", () => {
  for (const status of ["D", "R100"]) {
    const v = goldenGateVerdict({ changes: [{ status, path: G("a"), text: status === "D" ? null : golden(7) }], baseVersionText: versionFile(7), headVersionText: versionFile(7), tagged: true });
    assert.equal(v.ok, false, status);
  }
});

test("REFUSED: a new fixture with neither a bump nor the tag", () => {
  const v = goldenGateVerdict({ changes: [{ status: "A", path: G("new"), text: golden(7) }], baseVersionText: versionFile(7), headVersionText: versionFile(7), tagged: false });
  assert.equal(v.ok, false);
});

test("ACCEPTED: modified + deleted + added goldens with an integer increase, every one at the new version", () => {
  const v = goldenGateVerdict({
    changes: [{ status: "M", path: G("a"), text: golden(8) }, { status: "D", path: G("old") }, { status: "A", path: G("new"), text: golden(8) }],
    baseVersionText: versionFile(7),
    headVersionText: versionFile(8),
    tagged: false,
  });
  assert.deepEqual(v.reasons, []);
  assert.equal(v.ok, true);
  assert.match(v.summary, /7 → 8/);
});

test(`ACCEPTED: new fixtures only, tagged ${BUMP_TAG}, at the current version`, () => {
  const v = goldenGateVerdict({ changes: [{ status: "A", path: G("new"), text: golden(7) }], baseVersionText: versionFile(7), headVersionText: versionFile(7), tagged: true });
  assert.equal(v.ok, true);
});

test("REFUSED: a tagged new fixture that carries another version", () => {
  const v = goldenGateVerdict({ changes: [{ status: "A", path: G("new"), text: golden(6) }], baseVersionText: versionFile(7), headVersionText: versionFile(7), tagged: true });
  assert.equal(v.ok, false);
});
