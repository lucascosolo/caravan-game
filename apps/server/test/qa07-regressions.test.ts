/**
 * Chunk 07 QA round 1 — regressions for every item in roadmap/qa/07-punchlist.md, built
 * from the QA probes (scratchpad qa07/server.probe.ts, probe-pure.ts). Each test names the
 * punch-list item it pins. The pure-package items (S1, S8, N1, N3, N4, N6 and the D1/D2
 * geometry) are covered in packages/circle/test; this file covers the server boundary.
 */
import { TUNABLES } from "@caravan/content";
import { RING_ANCHORS, RING_SEGMENTS, canonicalJson, formationFromJson, serializeFormation, type Formation } from "@caravan/circle";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { applyOutcome, battlefieldForEncounter, closeManifest } from "../src/circle/service.js";
import { withTransaction } from "../src/db/pool.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique, commitFormationInTown } from "./helpers.js";

const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  units: Record<string, string>;
}

async function registerPlayer(region = "desert"): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("q"), password: "correct horse battery", region } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, units: {} };
}

async function giveUnit(p: Player, key: string, typeId: string, mergeLevel = 1): Promise<string> {
  const row = await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel });
  p.units[key] = row.id;
  return row.id;
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}`, ...headers } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  // Chunk 15 QA N4: the raw commit route is trip-only now; chunk 07's model tests commit through the service.
  return commitFormationInTown(appRole, p.caravanId, method, url).then((r) => (r as unknown as LightMyRequestResponse | null) ?? app.inject(opts));
}

const PACK = (p: Player) => ({ units: [p.units["rider"], p.units["digger"]], traps: ["trap.spike_pit", "trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 10 } });

type Survivors = { units: { ref: string; hp: number }[]; traps: { ref: string; spent: boolean }[]; fences: { ref: string; hp: number }[] };

/** Inner cells one in from the north-west anchor, row by row. */
function innerCells(): { x: number; y: number }[] {
  const corner = RING_ANCHORS[0]!;
  const cells: { x: number; y: number }[] = [];
  for (let y = corner.y + 1; y < corner.y + 4; y++) for (let x = corner.x + 1; x < corner.x + 8; x++) cells.push({ x, y });
  return cells;
}

/** Every intact fence on consecutive ring positions from `first`; unspent traps and living units on inner cells. */
function arrangement(s: Survivors, first = 0): Formation {
  const cells = innerCells();
  let i = 0;
  return {
    v: 2,
    fences: s.fences.filter((f) => f.hp > 0).map((f, k) => ({ ref: f.ref, segment: (first + k) % RING_SEGMENTS.length })),
    traps: s.traps.filter((t) => !t.spent).map((t) => ({ ref: t.ref, cell: cells[i++]! })),
    posts: s.units.filter((u) => u.hp > 0).map((u) => ({ ref: u.ref, cell: cells[i++]!, stance: "guard" as const })),
  };
}

async function newTrip(): Promise<{ p: Player; base: string; manifestId: string; survivors: Survivors }> {
  const p = await registerPlayer();
  await giveUnit(p, "rider", "desert.dust_rider");
  await giveUnit(p, "digger", "desert.well_digger", 2);
  const base = `/caravans/${p.caravanId}`;
  const res = await call(p, "POST", `${base}/manifest`, PACK(p));
  expect(res.statusCode).toBe(201);
  return { p, base, manifestId: res.json().manifest.id, survivors: res.json().manifest.survivors };
}

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("S4 — caravan ids that are not UUIDs are 404s, never 500s", () => {
  it("rejects dash-only, digit-only and wrongly-grouped 36-character ids", async () => {
    const p = await registerPlayer();
    for (const id of ["-".repeat(36), "0".repeat(36), `${"0".repeat(32)}----`, "not-a-uuid", p.caravanId.replace(/-/g, "")]) {
      const res = await call(p, "GET", `/caravans/${id}/manifest`);
      expect(res.statusCode, id).toBe(404);
      expect(res.json().error).toBe("no_caravan");
    }
    // A real UUID of a caravan that is not the caller's is also a 404, and the caller's own works.
    const other = await registerPlayer();
    expect((await call(p, "GET", `/caravans/${other.caravanId}/manifest`)).json().error).toBe("no_caravan");
    expect((await call(p, "GET", `/caravans/${p.caravanId}/manifest`)).json().error).toBe("no_open_manifest");
  });
});

describe("N2 — encounter index forms", () => {
  it("accepts only a positive integer with no leading zero and at most six digits", async () => {
    const { p, base } = await newTrip();
    for (const n of ["0", "1e3", " 1", "01", "1.0", "-1", "1000000", "+1", "٣"]) {
      const res = await call(p, "GET", `${base}/encounters/${encodeURIComponent(n)}/formation`);
      expect(res.statusCode, n).toBe(400);
      expect(res.json().error, n).toBe("bad_encounter");
    }
    const far = await call(p, "GET", `${base}/encounters/999999/formation`);
    expect(far.statusCode).toBe(404);
    expect(far.json().error).toBe("no_formation");
  });
});

describe("S3 — strict pack body and the non-empty manifest rule", () => {
  let p: Player;
  let base: string;
  beforeAll(async () => {
    p = await registerPlayer();
    await giveUnit(p, "rider", "desert.dust_rider");
    await giveUnit(p, "digger", "desert.well_digger", 2);
    base = `/caravans/${p.caravanId}`;
  });

  it("refuses arrays, unknown keys at both levels, and wrongly-typed fields with 400 bad_body", async () => {
    const cases: [unknown, string][] = [
      [[1, 2], "array body"],
      [{ units: "abc" }, "units string"],
      [{ ...PACK(p), extra: 1 }, "top-level unknown key"],
      [{ ...PACK(p), fence: { tierId: "fence.brush_pile", count: 10, extra: 1 } }, "fence unknown key"],
      [{ ...PACK(p), fence: { tierId: "fence.brush_pile", count: "24" } }, "count string"],
      [{ ...PACK(p), fence: [] }, "fence array"],
      [{ ...PACK(p), units: [p.units["rider"], 5] }, "unit id not a string"],
    ];
    for (const [body, why] of cases) {
      const res = await call(p, "POST", `${base}/manifest`, body);
      expect(res.statusCode, why).toBe(400);
      expect(res.json().error, why).toBe("bad_body");
    }
    const notJson = await call(p, "POST", `${base}/manifest`, "not json", { "content-type": "application/json" });
    expect(notJson.statusCode).toBe(400);
    // Nothing above locked a manifest.
    expect((await call(p, "GET", `${base}/manifest`)).statusCode).toBe(404);
  });

  it("refuses a manifest with no living unit: 400 manifest_empty, with the issue list", async () => {
    for (const body of [{}, { units: [] }, { units: [], traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 10 } }]) {
      const res = await call(p, "POST", `${base}/manifest`, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("manifest_empty");
      expect(res.json().issues.map((i: { code: string }) => i.code)).toContain("manifest_empty");
    }
    expect((await call(p, "GET", `${base}/manifest`)).statusCode).toBe(404);
    // An unknown or non-roster unit id is a 400 too (never a database error).
    for (const id of ["not-a-uuid", p.units["rider"]!.toUpperCase(), "00000000-0000-0000-0000-000000000000"]) {
      const res = await call(p, "POST", `${base}/manifest`, { ...PACK(p), units: [id] });
      expect(res.statusCode, id).toBe(400);
      expect(res.json().error, id).toBe("unknown_unit");
    }
  });

  it("two concurrent locks: exactly one wins", async () => {
    const [a, b] = await Promise.all([call(p, "POST", `${base}/manifest`, PACK(p)), call(p, "POST", `${base}/manifest`, PACK(p))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toBe("manifest_open");
  });
});

describe("D1 / D2 / S8 at the HTTP boundary", () => {
  it("D1: stances are accepted, defaulted and refused through the formation route", async () => {
    const { p, base, survivors } = await newTrip();
    const f = arrangement(survivors);
    const url = `${base}/encounters/1/formation`;
    // Mixed stances round-trip; the canonical form carries them and the hash covers them.
    const mixed = { ...f, posts: f.posts.map((post, i) => ({ ...post, stance: (["hold", "reserve"] as const)[i % 2]! })) };
    const saved = await call(p, "PUT", url, mixed);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().formation.formation.posts.map((x: { stance: string }) => x.stance).sort()).toEqual(["hold", "reserve"]);
    // Omitted stance is guard; a different stance is a different formation (different hash).
    const stripped = { ...f, posts: f.posts.map(({ ref, cell }) => ({ ref, cell })) };
    const defaulted = await call(p, "PUT", url, stripped);
    expect(defaulted.statusCode).toBe(200);
    expect(defaulted.json().formation.formation.posts.every((x: { stance: string }) => x.stance === "guard")).toBe(true);
    expect(defaulted.json().formation.hash).not.toBe(saved.json().formation.hash);
    for (const stance of ["attack", "GUARD", 1, null]) {
      const bad = await call(p, "PUT", url, { ...f, posts: [{ ...f.posts[0]!, stance }, ...f.posts.slice(1)] });
      expect(bad.statusCode, String(stance)).toBe(400);
      expect(bad.json().error).toBe("malformed_formation");
      expect(bad.json().message).toMatch(/must be one of guard, hold, reserve/);
    }
    // Version 1 bodies (no stance field in the shape) are refused by version.
    const v1 = await call(p, "PUT", url, { ...stripped, v: 1 });
    expect(v1.statusCode).toBe(400);
    expect(v1.json().message).toMatch(/unsupported formation version 1/);
  });

  it("D2: the ring has 28 fence positions and 20 of material; anchors are reserved cells", async () => {
    const { p, base, survivors } = await newTrip();
    expect(TUNABLES.PERIMETER_SEGMENTS).toBe(28);
    expect(TUNABLES.FENCE_MATERIAL_BUDGET).toBe(20);
    const url = `${base}/encounters/1/formation`;
    const f = arrangement(survivors);
    const seg28 = await call(p, "PUT", url, { ...f, fences: [{ ref: "f0", segment: 28 }, ...f.fences.slice(1)] });
    expect(seg28.statusCode).toBe(400);
    expect(seg28.json().message).toMatch(/not a ring position/);
    for (const a of RING_ANCHORS) {
      const onAnchor = await call(p, "PUT", url, { ...f, traps: [{ ref: "t0", cell: a }, ...f.traps.slice(1)] });
      expect(onAnchor.statusCode).toBe(400);
      expect(onAnchor.json().issues.map((i: { code: string }) => i.code)).toEqual(["cell_reserved"]);
    }
    // 21 segments cannot be packed; 20 can, and the ring still has 8 gaps.
    const q = await registerPlayer();
    await giveUnit(q, "rider", "desert.dust_rider");
    const over = await call(q, "POST", `/caravans/${q.caravanId}/manifest`, { units: [q.units["rider"]], fence: { tierId: "fence.brush_pile", count: 21 } });
    expect(over.json().issues.map((i: { code: string }) => i.code)).toEqual(["fence_budget"]);
    const full = await call(q, "POST", `/caravans/${q.caravanId}/manifest`, { units: [q.units["rider"]], fence: { tierId: "fence.brush_pile", count: 20 } });
    expect(full.statusCode).toBe(201);
    const fq = arrangement(full.json().manifest.survivors);
    const savedQ = await call(q, "PUT", `/caravans/${q.caravanId}/encounters/1/formation`, fq);
    expect(savedQ.statusCode).toBe(200);
    expect(savedQ.json().formation.gaps).toHaveLength(8);
  });

  it("S8: an oversized formation is refused cheaply with a small response", async () => {
    const { p, base } = await newTrip();
    const url = `${base}/encounters/1/formation`;
    const big = { v: 2, fences: [], traps: [], posts: Array.from({ length: 20_000 }, (_, i) => ({ ref: `z${i}`, cell: { x: 12, y: 12 } })) };
    const t0 = performance.now();
    const res = await call(p, "PUT", url, big);
    const ms = performance.now() - t0;
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("malformed_formation");
    expect(res.json().message).toMatch(/20000 posts placed; a formation carries at most 8/);
    expect(res.body.length).toBeLessThan(400);
    expect(ms).toBeLessThan(1000);
    const nine = await call(p, "PUT", url, { v: 2, fences: [], traps: [], posts: Array.from({ length: 9 }, (_, i) => ({ ref: `z${i}`, cell: { x: 12 + i, y: 12 } })) });
    expect(nine.statusCode).toBe(400);
    expect(nine.json().message).toMatch(/9 posts placed/);
    // A legal-sized formation with many problems reports at most 50 issues.
    const noisy = { v: 2, fences: Array.from({ length: 28 }, (_, i) => ({ ref: `nope${i}`, segment: i })), traps: [], posts: [] };
    const capped = await call(p, "PUT", url, noisy);
    expect(capped.statusCode).toBe(400);
    expect(capped.json().issues.length).toBeLessThanOrEqual(50);
    // Malformed bodies of other kinds are client errors too (415 for a non-JSON content type).
    for (const [payload, headers, status] of [
      ["nope", { "content-type": "application/json" }, 400],
      [undefined, {}, 400],
      ["str", {}, 415],
    ] as const) {
      const r = await call(p, "PUT", url, payload, headers as Record<string, string>);
      expect(r.statusCode, String(payload)).toBe(status);
    }
  });
});

describe("S2 / S7 — outcomes touch only what was in the fight; replay input is the committed snapshot", () => {
  it("refuses an outcome naming a trap not laid, a fence not placed or a unit not posted", async () => {
    const { p, base, manifestId, survivors } = await newTrip();
    const f = arrangement(survivors);
    // Hold back t1 and f9.
    const held: Formation = { ...f, traps: f.traps.filter((t) => t.ref !== "t1"), fences: f.fences.filter((x) => x.ref !== "f9") };
    expect((await call(p, "PUT", `${base}/encounters/1/formation`, held)).statusCode).toBe(200);
    expect((await call(p, "POST", `${base}/encounters/1/formation/commit`)).statusCode).toBe(200);
    const rider = survivors.units.find((u) => u.ref === p.units["rider"])!;
    const attempts: [Parameters<typeof applyOutcome>[3], RegExp][] = [
      [{ units: [], spentTraps: ["t1"], fences: [] }, /trap 't1' was not laid/],
      [{ units: [], spentTraps: [], fences: [{ ref: "f9", hp: 1 }] }, /fence 'f9' was not placed/],
      [{ units: [], spentTraps: [], fences: [{ ref: "f9", hp: 300 }] }, /fence 'f9' was not placed/],
      [{ units: [], spentTraps: ["t0", "t1"], fences: [{ ref: "f0", hp: 5 }, { ref: "f9", hp: 0 }] }, /trap 't1' was not laid; fence 'f9' was not placed/],
    ];
    for (const [outcome, why] of attempts) {
      await expect(withTransaction(appRole, (c) => applyOutcome(c, manifestId, 1, outcome))).rejects.toThrow(why);
    }
    // Unchanged after all of that.
    const m = (await call(p, "GET", `${base}/manifest`)).json().manifest;
    expect(m.encountersResolved).toBe(0);
    expect(m.survivors.traps.every((t: { spent: boolean }) => !t.spent)).toBe(true);
    // The rider dies in encounter 1. For encounter 2 it has no post, so an outcome may not mention it.
    await withTransaction(appRole, (c) => applyOutcome(c, manifestId, 1, { units: [{ ref: rider.ref, hp: 0 }], spentTraps: ["t0"], fences: [{ ref: "f0", hp: 0 }] }));
    const s2 = (await call(p, "GET", `${base}/manifest`)).json().manifest.survivors as Survivors;
    expect((await call(p, "PUT", `${base}/encounters/2/formation`, arrangement(s2))).statusCode).toBe(200);
    expect((await call(p, "POST", `${base}/encounters/2/formation/commit`)).statusCode).toBe(200);
    await expect(withTransaction(appRole, (c) => applyOutcome(c, manifestId, 2, { units: [{ ref: rider.ref, hp: 0 }], spentTraps: [], fences: [] }))).rejects.toThrow(/unit '.*' was not posted/);
    // And a malformed outcome is refused before anything is looked up (N4 through the service).
    await expect(withTransaction(appRole, (c) => applyOutcome(c, manifestId, 2, { spentTraps: [], fences: [] } as never))).rejects.toThrow(/malformed outcome/);
    await expect(withTransaction(appRole, (c) => applyOutcome(c, manifestId, 2, { units: [], spentTraps: [], fences: [], rearm: [] } as never))).rejects.toThrow(/malformed outcome/);
  });

  it("the battlefield for a resolved encounter is built from its survivors snapshot: pre-outcome HP, byte-reproducible", async () => {
    const { p, base, manifestId, survivors } = await newTrip();
    expect((await call(p, "PUT", `${base}/encounters/1/formation`, arrangement(survivors))).statusCode).toBe(200);
    expect((await call(p, "POST", `${base}/encounters/1/formation/commit`)).statusCode).toBe(200);
    const before = await battlefieldForEncounter(appRole, manifestId, 1);
    const beforeText = canonicalJson(JSON.parse(JSON.stringify(before)));
    const rider = survivors.units.find((u) => u.ref === p.units["rider"])!;
    await withTransaction(appRole, (c) => applyOutcome(c, manifestId, 1, { units: [{ ref: rider.ref, hp: 0 }], spentTraps: ["t0"], fences: [{ ref: "f1", hp: 17 }] }));
    // Live survivors moved on...
    const live = (await call(p, "GET", `${base}/manifest`)).json().manifest.survivors as Survivors;
    expect(live.units.find((u) => u.ref === rider.ref)!.hp).toBe(0);
    // ...but encounter 1's battlefield is exactly what it was.
    const after = await battlefieldForEncounter(appRole, manifestId, 1);
    expect(canonicalJson(JSON.parse(JSON.stringify(after)))).toBe(beforeText);
    expect(after.posts.find((x) => x.ref === rider.ref)!.hp).toBe(rider.hp);
    expect(after.fences.find((x) => x.ref === "f1")!.hp).toBe(300);
    // Encounter 2's battlefield is built from the snapshot taken at ITS commit: the chipped fence and the dead rider.
    expect((await call(p, "PUT", `${base}/encounters/2/formation`, arrangement(live))).statusCode).toBe(200);
    expect((await call(p, "POST", `${base}/encounters/2/formation/commit`)).statusCode).toBe(200);
    const bf2 = await battlefieldForEncounter(appRole, manifestId, 2);
    expect(bf2.fences.find((x) => x.ref === "f1")!.hp).toBe(17);
    expect(bf2.posts.map((x) => x.ref)).toEqual([p.units["digger"]]);
    // The stored snapshot equals the manifest's survivors at commit and re-canonicalizes to the same bytes.
    const rows = await pool.query<{ encounter_index: number; survivors_snapshot: unknown; formation: unknown }>(
      "SELECT encounter_index, survivors_snapshot, formation FROM wagon_formation WHERE manifest_id = $1 ORDER BY encounter_index",
      [manifestId],
    );
    expect(rows.rows.map((r) => r.encounter_index)).toEqual([1, 2]);
    expect(serializeFormation(formationFromJson(rows.rows[0]!.formation))).toBe(serializeFormation(arrangement(survivors)));
    expect(rows.rows[1]!.survivors_snapshot).toEqual(live);
    // Uncommitted / unresolved encounters still refuse.
    await expect(battlefieldForEncounter(appRole, manifestId, 3)).rejects.toThrow(/committed/);
  });

  it("the commit flow: no draft, early encounter, idempotent commit, frozen after commit, resolved encounters cannot be re-committed", async () => {
    const { p, base, manifestId, survivors } = await newTrip();
    const url = (n: number, s = "") => `${base}/encounters/${n}/formation${s}`;
    expect((await call(p, "POST", url(1, "/commit"))).json().error).toBe("no_draft");
    expect((await call(p, "PUT", url(1), arrangement(survivors))).statusCode).toBe(200);
    expect((await call(p, "PUT", url(2), arrangement(survivors))).json().error).toBe("wrong_encounter");
    const c1 = await call(p, "POST", url(1, "/commit"));
    expect(c1.statusCode).toBe(200);
    const c1again = await call(p, "POST", url(1, "/commit"));
    expect(c1again.json().formation.committedAt).toBe(c1.json().formation.committedAt);
    expect((await call(p, "PUT", url(1), arrangement(survivors, 3))).json().error).toBe("formation_committed");
    await withTransaction(appRole, (c) => applyOutcome(c, manifestId, 1, { units: [], spentTraps: [], fences: [] }));
    // Applying encounter 1 again is a wrong-encounter conflict; encounter 2 is not committed yet.
    await expect(withTransaction(appRole, (c) => applyOutcome(c, manifestId, 1, { units: [], spentTraps: [], fences: [] }))).rejects.toMatchObject({ code: "wrong_encounter" });
    await expect(withTransaction(appRole, (c) => applyOutcome(c, manifestId, 2, { units: [], spentTraps: [], fences: [] }))).rejects.toMatchObject({ code: "not_committed" });
    expect((await call(p, "POST", url(1, "/commit"))).json().error).toBe("wrong_encounter");
    expect((await call(p, "GET", url(1))).statusCode).toBe(200);
  });
});

describe("S6 / N5 / S7 — the database guards, exercised as the app role", () => {
  let manifestId: string;
  let base: string;
  let p: Player;
  beforeAll(async () => {
    const t = await newTrip();
    manifestId = t.manifestId;
    base = t.base;
    p = t.p;
    expect((await call(p, "PUT", `${base}/encounters/1/formation`, arrangement(t.survivors))).statusCode).toBe(200);
    expect((await call(p, "POST", `${base}/encounters/1/formation/commit`)).statusCode).toBe(200);
    const rider = t.survivors.units.find((u) => u.ref === p.units["rider"])!;
    await withTransaction(appRole, (c) => applyOutcome(c, manifestId, 1, { units: [{ ref: rider.ref, hp: 0 }], spentTraps: ["t0"], fences: [{ ref: "f0", hp: 0 }] }));
  });

  const refused = async (sql: string, why: RegExp, params: unknown[] = [manifestId]) => {
    const err = await expectDbError(appRole, sql, params);
    expect(err, sql).not.toBeNull();
    expect(err!.message, sql).toMatch(why);
  };

  it("S6: survivors entries keep their key sets, hp stays a bounded integer, refs stay distinct, the document shape is frozen", async () => {
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{units,1}', (survivors->'units'->1) - 'hp') WHERE id = $1`, /keys are immutable/);
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{units,1,heal}', '999') WHERE id = $1`, /keys are immutable/);
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{units,1,hp}', 'null') WHERE id = $1`, /hp must be an integer in 0..maxHp/);
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{units,1,hp}', '"5"') WHERE id = $1`, /hp must be an integer in 0..maxHp/);
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{units,1,hp}', '1.5') WHERE id = $1`, /hp must be an integer in 0..maxHp/);
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{fences,1,hp}', '-50') WHERE id = $1`, /hp must be an integer in 0..maxHp/);
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{fences,1,hp}', '1000000') WHERE id = $1`, /hp must be an integer in 0..maxHp|hp may not rise/);
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{traps,1,spent}', '"no"') WHERE id = $1`, /spent must be a boolean/);
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{v}', '2') WHERE id = $1`, /top-level keys other than units\/traps\/fences are immutable/);
    await refused(`UPDATE wagon_manifest SET survivors = survivors || '{"coin": 5}' WHERE id = $1`, /top-level keys other than units\/traps\/fences are immutable/);
    await refused(`UPDATE wagon_manifest SET survivors = survivors - 'v' WHERE id = $1`, /top-level keys other than units\/traps\/fences are immutable/);
    // Replacing the dead unit's entry with a copy of the living one keeps the array length but duplicates a ref.
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{units,0}', survivors->'units'->1) WHERE id = $1`, /refs must be distinct/);
    await refused(`UPDATE wagon_manifest SET survivors = jsonb_set(survivors, '{units,0}', '"x"') WHERE id = $1`, /entries must be objects|refs must be distinct/);
    // Still exactly what the outcome left.
    const m = (await call(p, "GET", `${base}/manifest`)).json().manifest;
    expect(m.encountersResolved).toBe(1);
    expect(m.summary).toEqual({ unitsAlive: 1, unitsDead: 1, trapsUnspent: 1, trapsSpent: 1, fencesIntact: 9, fencesDestroyed: 1 });
  });

  it("N5: encounters_resolved advances by exactly one; formation rows are born as drafts", async () => {
    await refused(`UPDATE wagon_manifest SET encounters_resolved = encounters_resolved + 5 WHERE id = $1`, /advances by exactly one/);
    await refused(`UPDATE wagon_manifest SET encounters_resolved = encounters_resolved + 2 WHERE id = $1`, /advances by exactly one/);
    await refused(`UPDATE wagon_manifest SET encounters_resolved = 0 WHERE id = $1`, /never decreases/);
    await refused(
      `INSERT INTO wagon_formation (manifest_id, encounter_index, formation, formation_hash, committed_at) VALUES ($1, 9, '{}', repeat('0', 64), now())`,
      /inserted as drafts|snapshot_iff_committed/,
    );
    await refused(
      `INSERT INTO wagon_formation (manifest_id, encounter_index, formation, formation_hash, survivors_snapshot) VALUES ($1, 9, '{}', repeat('0', 64), '{}')`,
      /inserted as drafts|snapshot_iff_committed/,
    );
    await refused(
      `INSERT INTO wagon_formation (manifest_id, encounter_index, formation, formation_hash, survivors_snapshot, committed_at) VALUES ($1, 9, '{}', repeat('0', 64), '{}', now())`,
      /inserted as drafts/,
    );
    expect((await pool.query("SELECT count(*)::int AS n FROM wagon_formation WHERE manifest_id = $1 AND encounter_index = 9", [manifestId])).rows[0].n).toBe(0);
  });

  it("S7: a snapshot exists iff committed, must equal the manifest's survivors at commit, and is frozen with the row", async () => {
    // Committed encounter 1: its snapshot cannot change, nor be removed.
    await refused(`UPDATE wagon_formation SET survivors_snapshot = '{}' WHERE manifest_id = $1 AND encounter_index = 1`, /committed and frozen/);
    await refused(`UPDATE wagon_formation SET survivors_snapshot = NULL, committed_at = NULL WHERE manifest_id = $1 AND encounter_index = 1`, /committed and frozen/);
    // A draft for encounter 2: committing it by hand needs the right snapshot and the right index.
    const s2 = (await call(p, "GET", `${base}/manifest`)).json().manifest.survivors as Survivors;
    expect((await call(p, "PUT", `${base}/encounters/2/formation`, arrangement(s2))).statusCode).toBe(200);
    await refused(`UPDATE wagon_formation SET committed_at = now() WHERE manifest_id = $1 AND encounter_index = 2`, /snapshot_iff_committed|must equal the manifest/);
    await refused(`UPDATE wagon_formation SET committed_at = now(), survivors_snapshot = '{}' WHERE manifest_id = $1 AND encounter_index = 2`, /must equal the manifest's current survivors/);
    await refused(
      `UPDATE wagon_formation SET committed_at = now(), survivors_snapshot = (SELECT packed FROM wagon_manifest WHERE id = $1) WHERE manifest_id = $1 AND encounter_index = 2`,
      /must equal the manifest's current survivors/,
    );
    await refused(`UPDATE wagon_formation SET survivors_snapshot = (SELECT survivors FROM wagon_manifest WHERE id = $1) WHERE manifest_id = $1 AND encounter_index = 2`, /snapshot_iff_committed/);
    // The honest commit (what the service does) is accepted, and the row is then frozen.
    await appRole.query(`UPDATE wagon_formation SET committed_at = now(), survivors_snapshot = (SELECT survivors FROM wagon_manifest WHERE id = $1) WHERE manifest_id = $1 AND encounter_index = 2`, [manifestId]);
    const row = (await pool.query<{ survivors_snapshot: unknown; committed_at: Date | null }>("SELECT survivors_snapshot, committed_at FROM wagon_formation WHERE manifest_id = $1 AND encounter_index = 2", [manifestId])).rows[0]!;
    expect(row.committed_at).not.toBeNull();
    expect(row.survivors_snapshot).toEqual(s2);
    await refused(`UPDATE wagon_formation SET formation = '{"v":2,"fences":[],"traps":[],"posts":[]}'::jsonb, formation_hash = repeat('0', 64) WHERE manifest_id = $1 AND encounter_index = 2`, /committed and frozen/);
    // A closed manifest's drafts cannot be committed either.
    await withTransaction(appRole, (c) => closeManifest(c, manifestId));
    await refused(`UPDATE wagon_manifest SET closed_at = NULL WHERE id = $1`, /closed and frozen/);
  });
});
