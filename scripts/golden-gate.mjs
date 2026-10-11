// The golden-log change rule (QA-13 S5), as a pure function so it can be self-tested on fixture
// diffs (scripts/golden-gate.test.mjs) and called by scripts/determinism.mjs on the real range.
//
// THE RULE. A golden log is what a stored input resolves to under one RESOLVER_VERSION; two
// behaviours must never ship under one version number (stored logs could no longer be re-checked
// against their inputs — the "provably fair" claim). So, over the range base..HEAD:
//   - a MODIFIED, DELETED or RENAMED golden requires RESOLVER_VERSION to INCREASE, read as an
//     integer from `export const RESOLVER_VERSION = N;` at base and at HEAD. A comment edit, a
//     reformat or a decrement is not a bump. The `[resolver-bump]` tag does NOT suffice.
//   - an ADDED golden (a new fixture) is accepted with a bump or with the `[resolver-bump]` tag.
//   - every added or modified golden must carry HEAD's RESOLVER_VERSION in its `resolverVersion`.

export const BUMP_TAG = "[resolver-bump]";

/** The integer in `export const RESOLVER_VERSION = N;`, or null when there is none. */
export function parseResolverVersion(text) {
  if (typeof text !== "string") return null;
  const m = /^export\s+const\s+RESOLVER_VERSION\s*=\s*(\d+)\s*;/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** The `resolverVersion` a golden file's text carries, or null when unreadable. */
export function goldenResolverVersion(text) {
  try {
    const v = JSON.parse(text).resolverVersion;
    return Number.isInteger(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} p
 * @param {{status: string, path: string, text?: string | null}[]} p.changes  `git diff --name-status` rows;
 *        `text` is the file at HEAD for added / modified / renamed-to goldens.
 * @param {string | null} p.baseVersionText  the version file at base
 * @param {string | null} p.headVersionText  the version file at HEAD
 * @param {boolean} p.tagged  a commit in the range carries BUMP_TAG
 * @returns {{ ok: boolean, reasons: string[], summary: string }}
 */
export function goldenGateVerdict({ changes, baseVersionText, headVersionText, tagged }) {
  if (changes.length === 0) return { ok: true, reasons: [], summary: "golden corpus unchanged" };
  const oldV = parseResolverVersion(baseVersionText);
  const newV = parseResolverVersion(headVersionText);
  const bumped = oldV !== null && newV !== null && newV > oldV;
  const reasons = [];
  const kind = (s) => s.charAt(0).toUpperCase();
  const rewrites = changes.filter((c) => ["M", "D", "R", "T"].includes(kind(c.status)));
  const additions = changes.filter((c) => ["A", "C"].includes(kind(c.status)));
  const unknown = changes.filter((c) => !["M", "D", "R", "T", "A", "C"].includes(kind(c.status)));
  for (const c of unknown) reasons.push(`${c.path}: unrecognised change status '${c.status}'`);
  const versions = `RESOLVER_VERSION ${oldV ?? "?"} → ${newV ?? "?"}`;
  if (rewrites.length > 0 && !bumped) {
    reasons.push(
      `${rewrites.length} existing golden log(s) changed (${rewrites.map((c) => `${kind(c.status)} ${c.path}`).join(", ")}) but ${versions} is not an integer increase` +
        (tagged ? ` — '${BUMP_TAG}' covers only NEW fixtures, never a changed or removed golden` : ""),
    );
  }
  if (additions.length > 0 && rewrites.length === 0 && !bumped && !tagged) {
    reasons.push(`${additions.length} golden log(s) added without a RESOLVER_VERSION increase or '${BUMP_TAG}' (${versions})`);
  }
  // Every golden written in the range must carry HEAD's version.
  for (const c of [...rewrites, ...additions]) {
    if (kind(c.status) === "D") continue;
    const v = goldenResolverVersion(c.text ?? null);
    if (newV === null) reasons.push(`${c.path}: HEAD has no readable RESOLVER_VERSION`);
    else if (v !== newV) reasons.push(`${c.path}: carries resolverVersion ${v ?? "(unreadable)"}, but HEAD's RESOLVER_VERSION is ${newV}`);
  }
  const ok = reasons.length === 0;
  const summary = ok
    ? bumped
      ? `accepted — ${versions}, every changed golden carries v${newV}`
      : `accepted — new fixtures only, commit tagged ${BUMP_TAG}`
    : "refused";
  return { ok, reasons, summary };
}
