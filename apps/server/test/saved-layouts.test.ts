/**
 * Chunk 51 — saved layouts. The caravan's last committed formation is stored (caravan_layout,
 * slot 0, keyed by caravan), normalised to the scout's main edge; choosing a candidate loads it
 * as a DRAFT turned to face that scout, minus what the caravan no longer has. The GET formation
 * route carries the `layout` note (left-out pieces, sides, hints switch, version marker).
 */
import { INTERIOR_POST_CELLS, RING_SEGMENTS, entryBand, layoutFromJson, loadLayout, saveLayout, savedSidesFacing, type Formation, type Manifest } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { drain } from "../src/jobs/worker.js";
import { doubleHandlers, type EncounterPlan } from "../src/dev/tripDouble.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { appRolePool, seasonCaravan, testPool, truncateAll, unique } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface P { token: string; accountId: string; caravanId: string; units: string[] }

async function register(): Promise<P> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("p"), password: "correct horse battery", region: "desert" } });
  expect(res.statusCode).toBe(201);
  const b = res.json();
  await seasonCaravan(pool, b.caravan.id);
  return { token: b.token, accountId: b.account.id, caravanId: b.caravan.id, units: [] };
}
async function give(p: P, n: number, typeId = "desert.dust_rider", mergeLevel = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel })).id);
  p.units.push(...ids);
  return ids;
}
const call = (p: P, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { authorization: `Bearer ${p.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const EDGES = ["north", "east", "south", "west"] as const;
async function makeOwner(rep: number): Promise<void> {
  const p = await register();
  await give(p, 3, "desert.dust_rider", 2);
  const party = { v: 1, units: p.units.map((ref, i) => ({ ref, stance: (["nearest", "traps", "core"] as const)[i % 3], edge: EDGES[i % 4]!, cell: entryBand(EDGES[i % 4]!)[i]! })), siege: ["siege.battering_wagon"] };
  expect((await call(p, "PUT", "/me/party", party)).statusCode).toBe(200);
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [p.accountId, rep]);
}

interface D extends P { rider: string; digger: string; third: string }
async function makeDefender(): Promise<D> {
  const p = await register();
  const [rider, third] = await give(p, 2, "desert.dust_rider", 2);
  const [digger] = await give(p, 1, "desert.well_digger", 1);
  await pool.query("UPDATE pool_progress SET reputation = 1000 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId]);
  return { ...p, rider: rider!, digger: digger!, third: third! };
}
async function pack(d: D, extraUnits: string[] = []): Promise<void> {
  const res = await call(d, "POST", `/caravans/${d.caravanId}/manifest`, { units: [d.rider, d.digger, d.third, ...extraUnits], traps: ["trap.spike_pit", "trap.spike_pit", "trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 6 } });
  expect(res.statusCode, res.body).toBe(201);
}
async function start(d: P): Promise<string> {
  const res = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().tripId;
}
async function survivors(d: P): Promise<any> {
  const res = await call(d, "GET", `/caravans/${d.caravanId}/manifest`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().manifest.survivors;
}
function arrangement(m: any, skipTrap = false): Formation {
  const cells = INTERIOR_POST_CELLS.slice(0, 21).map((c) => ({ x: c.x, y: c.y }));
  let i = 0;
  return {
    v: 3,
    fences: m.fences.filter((f: any) => f.hp > 0).map((f: any, k: number) => ({ ref: f.ref, segment: k % RING_SEGMENTS.length })),
    traps: m.traps.filter((t: any) => !t.spent).slice(skipTrap ? 1 : 0).map((t: any) => ({ ref: t.ref, cell: cells[i++]! })),
    posts: m.units.filter((u: any) => u.hp > 0).map((u: any) => ({ ref: u.ref, cell: cells[i++]!, stance: "guard" as const })),
  } as Formation;
}

/** search + choose; returns the chosen candidate's scout view. */
async function searchAndChoose(d: P, n: number): Promise<any> {
  const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/search`);
  expect(s.statusCode, s.body).toBe(201);
  const cand = s.json().menu.candidates[0];
  const ch = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/choose`, { candidateId: cand.candidateId });
  expect(ch.statusCode, ch.body).toBe(200);
  return cand.scout;
}
const getF = (d: P, n: number, ifNone = true) => call(d, "GET", `/caravans/${d.caravanId}/encounters/${n}/formation${ifNone ? "?ifNone=null" : ""}`);
async function draftOf(d: P, n: number): Promise<any> {
  const r = await getF(d, n);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function layoutRow(d: P): Promise<any | undefined> {
  return (await pool.query("SELECT * FROM caravan_layout WHERE caravan_id = $1 AND slot = 0", [d.caravanId])).rows[0];
}

interface Played { scout: any; survivorsBefore: any; committed: Formation }
/** choose, PUT the standard arrangement, commit via the trip route, resolve with the double. */
async function playEncounter(d: P, n: number, plan: EncounterPlan): Promise<Played> {
  const scout = await searchAndChoose(d, n);
  const survivorsBefore = await survivors(d);
  expect((await call(d, "PUT", `/caravans/${d.caravanId}/encounters/${n}/formation`, arrangement(survivorsBefore))).statusCode).toBe(200);
  const c = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/${n}/commit`);
  expect([200, 202], c.body).toContain(c.statusCode);
  const committed = (await draftOf(d, n)).formation.formation as Formation;
  await drain(pool, { workerId: "sl-test", handlers: doubleHandlers({ [n]: plan }), retryBackoffMs: () => 0 });
  expect((await call(d, "GET", `/me/caravans/${d.caravanId}/trip`)).statusCode).toBe(200);
  return { scout, survivorsBefore, committed };
}
const push = (d: P, tripId: string, n: number) => call(d, "POST", `/me/caravans/${d.caravanId}/trip/push`, { tripId, encounterIndex: n });
const bank = (d: P, tripId: string, n: number) => call(d, "POST", `/me/caravans/${d.caravanId}/trip/bank`, { tripId, encounterIndex: n });
async function insertTrips(caravanId: string, reason: "banked" | "overrun", count: number): Promise<void> {
  const empty = JSON.stringify({ v: 1, units: [], traps: [], fences: [] });
  for (let i = 0; i < count; i++) {
    await pool.query(
      `WITH m AS (INSERT INTO wagon_manifest (caravan_id, packed, survivors, closed_at, created_at) VALUES ($1, $2::jsonb, $2::jsonb, now() - interval '1 day', now() - interval '1 day') RETURNING id)
       INSERT INTO trip (caravan_id, manifest_id, battlefield_version, started_at, ended_at, end_reason) SELECT $1, m.id, 3, now() - interval '1 day', now() - interval '1 day', $3 FROM m`,
      [caravanId, empty, reason],
    );
  }
}

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
  for (let i = 0; i < 10; i++) await makeOwner(950 + i * 10);
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("storage: caravan_layout", () => {
  it("is keyed by caravan with a slot, no account column", async () => {
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'caravan_layout' ORDER BY column_name");
    expect(cols.rows.map((r) => r.column_name)).toEqual(["battlefield_version", "caravan_id", "layout", "slot", "updated_at"]);
  });

  it("a trip commit stores saveLayout(committed, survivors, scout) at (caravan, 0) with battlefield_version 3", async () => {
    const d = await makeDefender();
    await pack(d);
    await start(d);
    const p = await playEncounter(d, 1, { kind: "caravan_held" });
    const row = await layoutRow(d);
    expect(row).toMatchObject({ caravan_id: d.caravanId, slot: 0, battlefield_version: 3 });
    expect(layoutFromJson(row.layout)).toEqual(saveLayout(p.committed, p.survivorsBefore as Manifest, p.scout));
  });

  it("the formation/commit route stores it too", async () => {
    const d = await makeDefender();
    await pack(d);
    await start(d);
    const scout = await searchAndChoose(d, 1);
    const sv = await survivors(d);
    expect((await call(d, "PUT", `/caravans/${d.caravanId}/encounters/1/formation`, arrangement(sv))).statusCode).toBe(200);
    const c = await call(d, "POST", `/caravans/${d.caravanId}/encounters/1/formation/commit`);
    expect(c.statusCode, c.body).toBe(200);
    const committed = c.json().formation.formation as Formation;
    expect(layoutFromJson((await layoutRow(d)).layout)).toEqual(saveLayout(committed, sv as Manifest, scout));
  });

  it("an uncommitted draft saves nothing", async () => {
    const d = await makeDefender();
    await pack(d);
    await start(d);
    await searchAndChoose(d, 1);
    await call(d, "PUT", `/caravans/${d.caravanId}/encounters/1/formation`, arrangement(await survivors(d)));
    expect(await layoutRow(d)).toBeUndefined();
  });
});

describe("auto-load at choose", () => {
  it("no saved layout: no draft, layout null", async () => {
    const d = await makeDefender();
    await pack(d);
    await start(d);
    await searchAndChoose(d, 1);
    const g = await draftOf(d, 1);
    expect(g.formation).toBeNull();
    expect(g.layout).toBeNull();
  });

  it("encounter 2 after a push: the draft is loadLayout(saved, survivors, scout); layout carries leftOut, savedSides, hintsOn", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await playEncounter(d, 1, { kind: "caravan_held" });
    expect((await push(d, tripId, 1)).statusCode).toBe(200);
    const g0 = await getF(d, 2);
    expect(g0.json().layout, "no candidate chosen yet").toBeNull();
    const scout2 = await searchAndChoose(d, 2);
    const saved = layoutFromJson((await layoutRow(d)).layout);
    const expected = loadLayout(saved, (await survivors(d)) as Manifest, scout2);
    const g = await draftOf(d, 2);
    expect(g.formation).not.toBeNull();
    expect(g.formation.formation).toEqual(expected.formation);
    expect(g.formation.committedAt).toBeNull();
    expect(g.layout).toMatchObject({ leftOut: expected.leftOut, savedSides: savedSidesFacing(saved, scout2), hintsOn: true, unavailable: null });
    expect(g.layout.loaded).toEqual(expected.formation);
    const plain = await getF(d, 2, false);
    expect(plain.statusCode).toBe(200);
    expect(plain.json().layout).toEqual(g.layout);
  });

  it("encounter 1 of a NEW trip after banking, same units packed", async () => {
    const d = await makeDefender();
    await pack(d);
    const t1 = await start(d);
    await playEncounter(d, 1, { kind: "caravan_held" });
    expect((await bank(d, t1, 1)).statusCode).toBe(200);
    await pack(d);
    await start(d);
    const scout = await searchAndChoose(d, 1);
    const saved = layoutFromJson((await layoutRow(d)).layout);
    const expected = loadLayout(saved, (await survivors(d)) as Manifest, scout);
    const g = await draftOf(d, 1);
    expect(g.formation.formation).toEqual(expected.formation);
    expect(g.formation.formation.posts.length).toBeGreaterThan(0);
    expect(g.layout.savedSides).toEqual(savedSidesFacing(saved, scout));
  });

  it("an invalid loaded formation (a packed living unit the layout does not post) saves no draft", async () => {
    const d = await makeDefender();
    await pack(d);
    const t1 = await start(d);
    await playEncounter(d, 1, { kind: "caravan_held" });
    expect((await bank(d, t1, 1)).statusCode).toBe(200);
    const [extra] = await give(d, 1, "desert.dust_rider", 1);
    await pack(d, [extra!]);
    await start(d);
    await searchAndChoose(d, 1);
    const g = await draftOf(d, 1);
    expect(g.formation).toBeNull();
    const draftRows = await pool.query("SELECT 1 FROM wagon_formation f JOIN wagon_manifest m ON m.id = f.manifest_id WHERE m.caravan_id = $1 AND m.closed_at IS NULL", [d.caravanId]);
    expect(draftRows.rowCount).toBe(0);
  });

  it("an existing draft is never overwritten: a player edit survives a repeated choose", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await playEncounter(d, 1, { kind: "caravan_held" });
    expect((await push(d, tripId, 1)).statusCode).toBe(200);
    const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/2/search`);
    const candidateId = s.json().menu.candidates[0].candidateId;
    const choose = () => call(d, "POST", `/me/caravans/${d.caravanId}/encounters/2/choose`, { candidateId });
    expect((await choose()).statusCode).toBe(200);
    const loaded = (await draftOf(d, 2)).formation.formation;
    expect(loaded.posts.length).toBeGreaterThan(0);
    const edited = arrangement(await survivors(d), true);
    expect((await call(d, "PUT", `/caravans/${d.caravanId}/encounters/2/formation`, edited)).statusCode).toBe(200);
    const before = (await draftOf(d, 2)).formation;
    expect(before.formation.traps.length).toBe(loaded.traps.length - 1);
    expect((await choose()).statusCode).toBe(200);
    expect((await draftOf(d, 2)).formation).toEqual(before);
  });

  it("layout is null once the encounter's formation is committed", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await playEncounter(d, 1, { kind: "caravan_held" });
    expect((await push(d, tripId, 1)).statusCode).toBe(200);
    await searchAndChoose(d, 2);
    expect((await draftOf(d, 2)).layout).not.toBeNull();
    expect([200, 202]).toContain((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/2/commit`)).statusCode);
    const g = await draftOf(d, 2);
    expect(g.formation.committedAt).not.toBeNull();
    expect(g.layout).toBeNull();
  });

  it("attrition floor: a dead unit and a spent trap from encounter 1 never return at encounter 2", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await playEncounter(d, 1, { kind: "caravan_held", kill: [d.third], spendTraps: 1 });
    expect((await push(d, tripId, 1)).statusCode).toBe(200);
    const scout2 = await searchAndChoose(d, 2);
    const sv = await survivors(d);
    const saved = layoutFromJson((await layoutRow(d)).layout);
    const expected = loadLayout(saved, sv as Manifest, scout2);
    const g = await draftOf(d, 2);
    const f = g.formation.formation as Formation;
    expect(f).toEqual(expected.formation);
    expect(f.posts.map((p) => p.ref)).not.toContain(d.third);
    expect(f.traps.length).toBe(2);
    expect(g.layout.leftOut.map((l: any) => l.reason)).toEqual(expect.arrayContaining(["dead"]));
  });

  it("a layout saved under battlefield version 2 is not loaded, and says so", async () => {
    const d = await makeDefender();
    await pack(d);
    const t1 = await start(d);
    await playEncounter(d, 1, { kind: "caravan_held" });
    expect((await bank(d, t1, 1)).statusCode).toBe(200);
    await pool.query("UPDATE caravan_layout SET battlefield_version = 2, layout = jsonb_set(layout, '{battlefieldVersion}', '2') WHERE caravan_id = $1", [d.caravanId]);
    await pack(d);
    await start(d);
    await searchAndChoose(d, 1);
    const g = await draftOf(d, 1);
    expect(g.formation).toBeNull();
    expect(g.layout.unavailable).toBe("battlefield_version");
    expect(g.layout.loaded).toEqual({ v: 3, fences: [], traps: [], posts: [] });
  });
});

describe("hints fade with experience", () => {
  it("LAYOUT_HINTS_UNTIL_BANKS is 10; hintsOn flips at that many banked trips; overrun trips do not count", async () => {
    expect((TUNABLES as any).LAYOUT_HINTS_UNTIL_BANKS).toBe(10);
    const limit: number = (TUNABLES as any).LAYOUT_HINTS_UNTIL_BANKS;
    const d = await makeDefender(); // seasonCaravan gave it AUTHORED_ONLY_UNTIL_BANKS banked trips
    await pack(d);
    const tripId = await start(d);
    await playEncounter(d, 1, { kind: "caravan_held" });
    expect((await push(d, tripId, 1)).statusCode).toBe(200);
    await searchAndChoose(d, 2);
    const hints = async () => (await draftOf(d, 2)).layout.hintsOn;
    expect(await hints()).toBe(true);
    await insertTrips(d.caravanId, "overrun", limit); // not counted
    expect(await hints()).toBe(true);
    await insertTrips(d.caravanId, "banked", limit - TUNABLES.AUTHORED_ONLY_UNTIL_BANKS - 1);
    expect(await hints()).toBe(true);
    await insertTrips(d.caravanId, "banked", 1);
    expect(await hints()).toBe(false);
  });
});

describe("no Coin path", () => {
  it("apps/server/src/circle/layout.ts reads no purchase, entitlement, Coin or store state", () => {
    const src = readFileSync(join(HERE, "../src/circle/layout.ts"), "utf8");
    expect(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/purchase|entitlement|coin|store/i);
  });
});
