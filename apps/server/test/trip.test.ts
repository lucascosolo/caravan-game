/**
 * Chunk 15 — the trip loop. Trip start (trip cap, caravan.state, trip_started), the
 * encounter chain through chunk 14's search/choose and chunk 07's arrangement, resolution
 * through the trip loop's seam (src/trip/outcome.ts) with the deterministic double in
 * trip-double.ts, settle-exactly-once (attrition, progression, unbanked Coin), bank / push /
 * overrun / stalemate, NO repair between encounters, the bank-or-push stakes preview, and
 * idempotency under retries and races (double bank, bank racing push, two starts, settles
 * racing). Production resolves with the real resolver since chunk 13 (ENCOUNTER_RESOLUTION_WIRED);
 * the same loop under it is exercised in trip-resolver.test.ts.
 */
import { RING_ANCHORS, RING_SEGMENTS, entryBand, type Formation, type PartyConfig } from "@caravan/circle";
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import type { CaravanRow } from "../src/db/types.js";
import { coinForBankedTrip, coinForDelivery, coinForEncounter, coinForEncountersSurvived } from "../src/economy/coin.js";
import { DEFAULT_HANDLERS, ENCOUNTER_RESOLUTION_WIRED } from "../src/jobs/handlers/encounterResolution.js";
import { getJob } from "../src/jobs/queue.js";
import { drain, verifyJobReplay, type HandlerRegistry } from "../src/jobs/worker.js";
import type { LedgerEventRow } from "../src/ledger/events.js";
import { seedAuthoredParties } from "../src/matchmaking/authored.js";
import { ESCALATION_PER_ENCOUNTER, bandOf, escalationFor } from "../src/matchmaking/band.js";

/** Chunk 19 QA D2a: every defender here searches at living 1000 (REPUTATION_START) and holds, so its display band stays 3. */
const BAND = bandOf(1000).index;
import { findCaravanById } from "../src/repo/caravans.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { TRIP_CAP_REGEN_MS, TRIPS_PER_HOUR_CAP, capAvailable, capConsume, capView } from "../src/trip/cap.js";
import { ENCOUNTER_OUTCOME_KINDS, EncounterOutcomeError, assertTripEncounterOutcome } from "../src/trip/outcome.js";
import { ENCOUNTER_OUTCOME_KINDS as PROGRESSION_KINDS } from "../src/progression/outcome.js";
import { settleEncounter, startTrip, type StakesPreview, type TripStatusView } from "../src/trip/service.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";
import { doubleHandlers, type EncounterPlan } from "./trip-double.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  units: string[];
}

async function registerPlayer(region = "desert"): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("p"), password: "correct horse battery", region } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, units: [] };
}

async function giveUnits(p: Player, n: number, typeId = "desert.dust_rider", mergeLevel = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: typeId, mergeLevel })).id);
  p.units.push(...ids);
  return ids;
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

const EDGES = ["north", "east", "south", "west"] as const;
function fullParty(units: string[]): PartyConfig {
  const stances = ["nearest", "traps", "core"] as const;
  return {
    v: 1,
    units: units.map((ref, i) => {
      const edge = EDGES[i % 4]!;
      return { ref, stance: stances[i % 3]!, edge, cell: entryBand(edge)[i]! };
    }),
    siege: ["siege.battering_wagon"],
  };
}

/** A party owner: a registered player whose standing party stands, at the given siege Reputation. */
async function makeOwner(siegeRep: number): Promise<Player> {
  const p = await registerPlayer("desert");
  await giveUnits(p, 3, "desert.dust_rider", 2);
  expect((await call(p, "PUT", "/me/party", fullParty(p.units))).statusCode).toBe(200);
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [p.accountId, siegeRep]);
  return p;
}

interface Defender extends Player {
  rider: string;
  digger: string;
  third: string;
}

/** A defender in town with three units; living Reputation 1000. */
async function makeDefender(): Promise<Defender> {
  const p = await registerPlayer("desert");
  const [rider, third] = await giveUnits(p, 2, "desert.dust_rider", 2);
  const [digger] = await giveUnits(p, 1, "desert.well_digger", 1);
  await pool.query("UPDATE pool_progress SET reputation = 1000 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId]);
  return { ...p, rider: rider!, digger: digger!, third: third! };
}

const PACK = (d: Defender) => ({ units: [d.rider, d.digger, d.third], traps: ["trap.spike_pit", "trap.spike_pit", "trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 6 } });

async function pack(d: Defender): Promise<void> {
  const res = await call(d, "POST", `/caravans/${d.caravanId}/manifest`, PACK(d));
  expect(res.statusCode, res.body).toBe(201);
}

async function start(d: Player): Promise<string> {
  const res = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().tripId;
}

interface ManifestJson {
  units: { ref: string; typeId: string; mergeLevel: number; hp: number; maxHp: number }[];
  traps: { ref: string; typeId: string; spent: boolean }[];
  fences: { ref: string; tierId: string; hp: number; maxHp: number }[];
}

async function survivors(d: Player): Promise<ManifestJson> {
  const res = await call(d, "GET", `/caravans/${d.caravanId}/manifest`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().manifest.survivors;
}

/** Every usable fence, trap and living unit placed (chunk 07's test arrangement). */
function arrangement(m: ManifestJson): Formation {
  const corner = RING_ANCHORS[0]!;
  const cells: { x: number; y: number }[] = [];
  for (let y = corner.y + 1; y < corner.y + 4; y++) for (let x = corner.x + 1; x < corner.x + 8; x++) cells.push({ x, y });
  let i = 0;
  return {
    v: 2,
    fences: m.fences.filter((f) => f.hp > 0).map((f, k) => ({ ref: f.ref, segment: k % RING_SEGMENTS.length })),
    traps: m.traps.filter((t) => !t.spent).map((t) => ({ ref: t.ref, cell: cells[i++]! })),
    posts: m.units.filter((u) => u.hp > 0).map((u) => ({ ref: u.ref, cell: cells[i++]!, stance: "guard" as const })),
  };
}

async function searchAndChoose(d: Player, n: number, pick: (c: { candidateId: string; owner: { authored: boolean } }[]) => string = (cs) => cs[0]!.candidateId): Promise<void> {
  const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/search`);
  expect(s.statusCode, s.body).toBe(201);
  const ch = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/choose`, { candidateId: pick(s.json().menu.candidates) });
  expect(ch.statusCode, ch.body).toBe(200);
}

async function arrangeAndCommit(d: Player, n: number): Promise<string> {
  const f = await call(d, "PUT", `/caravans/${d.caravanId}/encounters/${n}/formation`, arrangement(await survivors(d)));
  expect(f.statusCode, f.body).toBe(200);
  const c = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/${n}/commit`);
  expect([200, 202], c.body).toContain(c.statusCode);
  return c.json().jobId;
}

const worker = (handlers: HandlerRegistry) => drain(pool, { workerId: "trip-test", handlers, retryBackoffMs: () => 0 });

/** search → choose → arrange → commit → resolve (double) → settle (via GET). */
async function encounter(d: Player, n: number, plan: EncounterPlan): Promise<TripStatusView> {
  await searchAndChoose(d, n);
  await arrangeAndCommit(d, n);
  await worker(doubleHandlers({ [n]: plan }));
  return status(d);
}

async function status(d: Player): Promise<TripStatusView> {
  const res = await call(d, "GET", `/me/caravans/${d.caravanId}/trip`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function preview(d: Player): Promise<StakesPreview> {
  const res = await call(d, "GET", `/me/caravans/${d.caravanId}/trip/preview`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const push = (d: Player, tripId: string, encounterIndex: number) => call(d, "POST", `/me/caravans/${d.caravanId}/trip/push`, { tripId, encounterIndex });
const bank = (d: Player, tripId: string, encounterIndex: number) => call(d, "POST", `/me/caravans/${d.caravanId}/trip/bank`, { tripId, encounterIndex });

async function caravanRow(d: Player): Promise<CaravanRow> {
  return (await findCaravanById(pool, d.caravanId))!;
}

async function eventsOf(accountId: string, type?: string): Promise<LedgerEventRow[]> {
  const res = await pool.query<LedgerEventRow>(
    `SELECT * FROM ledger_event WHERE account_id = $1${type ? " AND event_type = $2" : ""} ORDER BY seq`,
    type ? [accountId, type] : [accountId],
  );
  return res.rows;
}

async function tripCoinEvents(accountId: string, tripId: string): Promise<LedgerEventRow[]> {
  return (await eventsOf(accountId, "coin_earned")).filter((e) => e.payload["tripId"] === tripId);
}

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
  // Twelve live owners inside the defenders' band, so recent-opponent exclusion never starves a search.
  for (let i = 0; i < 12; i++) await makeOwner(950 + i * 10);
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the trip cap (pure): 3 stored, one back every 20 minutes, computed from one timestamp", () => {
  it("defaults are the brief's and the bucket math is exact", () => {
    expect(TRIPS_PER_HOUR_CAP).toBe(3);
    expect(TRIP_CAP_REGEN_MS).toBe(20 * 60_000);
    const t = 10_000_000;
    expect(capAvailable(0, t)).toBe(3);
    let tat = 0;
    for (const left of [2, 1, 0]) {
      tat = capConsume(tat, t);
      expect(capAvailable(tat, t)).toBe(left);
    }
    expect(() => capConsume(tat, t)).toThrow(/no trip-cap use/);
    expect(capView(tat, t)).toMatchObject({ available: 0, nextRegenAtMs: t + TRIP_CAP_REGEN_MS, fullAtMs: t + 3 * TRIP_CAP_REGEN_MS, gate: "time" });
    expect(capAvailable(tat, t + TRIP_CAP_REGEN_MS - 1)).toBe(0);
    expect(capAvailable(tat, t + TRIP_CAP_REGEN_MS)).toBe(1);
    expect(capAvailable(tat, t + 2 * TRIP_CAP_REGEN_MS)).toBe(2);
    expect(capAvailable(tat, t + 3 * TRIP_CAP_REGEN_MS)).toBe(3);
    // Idle time beyond a full bucket is not banked: never more than 3.
    expect(capAvailable(tat, t + 100 * TRIP_CAP_REGEN_MS)).toBe(3);
    const later = capConsume(tat, t + 100 * TRIP_CAP_REGEN_MS);
    expect(capAvailable(later, t + 100 * TRIP_CAP_REGEN_MS)).toBe(2);
    expect(capView(0, t)).toMatchObject({ available: 3, nextRegenAtMs: null, fullAtMs: null });
  });

  it("the cap module reads no Coin, purchase or entitlement state", () => {
    const src = readFileSync(join(HERE, "../src/trip/cap.ts"), "utf8");
    expect(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/coin|purchase|entitle|pack_|spend/i);
  });
});

describe("the EncounterOutcome seam (pure)", () => {
  const ok = { kind: "caravan_held", depth: 512, endTick: 600, loot: 141, units: [{ ref: "u", hp: 3 }], spentTraps: ["t0"], fences: [{ ref: "f0", hp: 0 }] };
  it("has exactly chunk 04's three outcome kinds", () => {
    expect([...ENCOUNTER_OUTCOME_KINDS]).toEqual([...PROGRESSION_KINDS]);
  });
  it("accepts a well-formed outcome and refuses every malformed one", () => {
    expect(() => assertTripEncounterOutcome(ok)).not.toThrow();
    const bad: unknown[] = [
      null,
      [],
      { ...ok, kind: "caravan_raided" },
      { ...ok, depth: 0.5 },
      { ...ok, depth: -1 },
      { ...ok, depth: FIXED_ONE + 1 },
      { ...ok, kind: "caravan_overrun", depth: 100 },
      { ...ok, extra: 1 },
      { kind: ok.kind, depth: ok.depth, endTick: ok.endTick, loot: ok.loot, units: ok.units, spentTraps: ok.spentTraps },
      { ...ok, endTick: -1 },
      { ...ok, endTick: 1.5 },
      { ...ok, loot: -1 },
      { ...ok, loot: 0.5 },
      { ...ok, kind: "stalemate", loot: 1 },
      { ...ok, units: [{ ref: "u", hp: 1.5 }] },
      { ...ok, units: [{ ref: "u", hp: 1, heal: 2 }] },
      { ...ok, spentTraps: [""] },
    ];
    for (const b of bad) expect(() => assertTripEncounterOutcome(b), JSON.stringify(b)).toThrow(EncounterOutcomeError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("trip start", () => {
  it("refuses without a packed manifest; otherwise consumes one use, flips caravan.state, opens the trip, writes trip_started", async () => {
    const d = await makeDefender();
    const none = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`);
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe("not_packed");
    expect((await status(d)).cap.available).toBe(3);

    await pack(d);
    expect((await caravanRow(d)).state).toBe("in_town"); // packing never moves the state (chunk 17 D2)
    const tripId = await start(d);
    expect((await caravanRow(d)).state).toBe("on_trip");
    const s = await status(d);
    expect(s.cap.available).toBe(2);
    expect(s.trip).toMatchObject({ id: tripId, phase: "arranging", currentEncounter: 1, encountersResolved: 0, unbankedCoin: 0, endReason: null });
    const started = await eventsOf(d.accountId, "trip_started");
    expect(started.length).toBe(1);
    expect(started[0]!.caravan_id).toBe(d.caravanId);
    expect(started[0]!.payload).toMatchObject({ tripId, tripCap: { availableBefore: 3, availableAfter: 2, cap: 3 } });

    // On a trip: a second start, a re-pack and a merge are all refused; no second use consumed.
    const again = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("trip_open");
    const repack = await call(d, "POST", `/caravans/${d.caravanId}/manifest`, PACK(d));
    expect(repack.statusCode).toBe(409);
    expect(repack.json().error).toBe("manifest_open");
    const merge = await call(d, "POST", `/me/caravans/${d.caravanId}/merge`, { instanceIds: [d.rider, d.third] });
    expect(merge.statusCode).toBe(409);
    expect(["caravan_on_trip", "unit_packed"]).toContain(merge.json().error);
    expect((await status(d)).cap.available).toBe(2);
  });

  it("two concurrent starts: exactly one trip, exactly one use consumed", async () => {
    const d = await makeDefender();
    await pack(d);
    const results = await Promise.all(Array.from({ length: 4 }, () => call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409]);
    const trips = await pool.query("SELECT id FROM trip WHERE caravan_id = $1", [d.caravanId]);
    expect(trips.rowCount).toBe(1);
    expect((await status(d)).cap.available).toBe(2);
    expect((await eventsOf(d.accountId, "trip_started")).length).toBe(1);
  });

  it("enforces the cap: three starts, then a 409 with Retry-After until a use regenerates; one use per trip however many encounters", async () => {
    const d = await makeDefender();
    const caravan = await caravanRow(d);
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      await pack(d);
      await withTransaction(appRole, (c) => startTrip(c, caravan, t0));
      // Two encounters on the third trip: still one use.
      const tripId = (await status(d)).trip!.id;
      await encounter(d, 1, { kind: "caravan_held" });
      if (i === 2) {
        expect((await push(d, tripId, 1)).statusCode).toBe(200);
        await encounter(d, 2, { kind: "caravan_held" });
        expect((await bank(d, tripId, 2)).statusCode).toBe(200);
      } else {
        expect((await bank(d, tripId, 1)).statusCode).toBe(200);
      }
    }
    await pack(d);
    await expect(withTransaction(appRole, (c) => startTrip(c, caravan, t0))).rejects.toMatchObject({ code: "trip_cap_exhausted" });
    const http = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/start`);
    expect(http.statusCode).toBe(409);
    expect(http.json().error).toBe("trip_cap_exhausted");
    expect(Number(http.headers["retry-after"])).toBeGreaterThan(0);
    expect(http.json().cap).toMatchObject({ available: 0, gate: "time" });
    await expect(withTransaction(appRole, (c) => startTrip(c, caravan, t0 + TRIP_CAP_REGEN_MS - 1))).rejects.toMatchObject({ code: "trip_cap_exhausted" });
    await withTransaction(appRole, (c) => startTrip(c, caravan, t0 + TRIP_CAP_REGEN_MS));
    expect((await caravanRow(d)).state).toBe("on_trip");
  });

  it("the stored cap timestamp can never move back (no refund path), as the app role", async () => {
    const res = await appRole.query<{ account_id: string }>("SELECT account_id FROM trip_cap LIMIT 1");
    const err = await expectDbError(appRole, "UPDATE trip_cap SET tat_ms = 0 WHERE account_id = $1", [res.rows[0]!.account_id]);
    expect(err?.message).toMatch(/never refunded/);
    expect((await expectDbError(appRole, "DELETE FROM trip_cap WHERE account_id = $1", [res.rows[0]!.account_id]))?.message).toMatch(/may not be deleted/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the encounter chain: attrition carries forward, nothing is repaired, bank pays exactly once", () => {
  let d: Defender;
  let tripId: string;
  let before: ManifestJson;

  beforeAll(async () => {
    d = await makeDefender();
    await pack(d);
    tripId = await start(d);
    before = await survivors(d);
  });

  it("encounter 1 held: damage, a spent trap and a chipped fence are folded in; Coin accrues as trip state only", async () => {
    const balance0 = (await pool.query("SELECT coin_balance FROM account WHERE id = $1", [d.accountId])).rows[0].coin_balance;
    const s = await encounter(d, 1, { kind: "caravan_held", unitDamage: 5, spendTraps: 1, fenceDamage: 3 });
    expect(s.trip).toMatchObject({ phase: "decide", decisionFor: 1, encountersResolved: 1, unbankedCoin: coinForEncounter(1, BAND) });
    // Chunk 23 added `result` (the fight's own delta, for the client); the chunk 15 fields are unchanged.
    expect(s.trip!.encounters).toEqual([expect.objectContaining({ index: 1, outcome: "caravan_held", depth: 512, deaths: [], coinAccrued: coinForEncounter(1, BAND), decision: null })]);
    expect(Object.keys(s.trip!.encounters[0]!).sort()).toEqual(["coinAccrued", "deaths", "decision", "depth", "index", "outcome", "result"]);
    const m = await survivors(d);
    for (const u of m.units) expect(u.hp).toBe(before.units.find((b) => b.ref === u.ref)!.hp - 5);
    expect(m.traps.map((t) => t.spent)).toEqual([true, false, false]);
    for (const f of m.fences) expect(f.hp).toBe(f.maxHp - 3);
    // Unbanked: the account balance did not move, no coin_earned for this trip exists.
    expect((await pool.query("SELECT coin_balance FROM account WHERE id = $1", [d.accountId])).rows[0].coin_balance).toBe(balance0);
    expect(await tripCoinEvents(d.accountId, tripId)).toEqual([]);
    // Progression ran once, under the job's causation id, for both sides.
    const rep = await eventsOf(d.accountId, "reputation_changed");
    expect(rep.length).toBe(1);
    expect(rep[0]!.payload).toMatchObject({ pool: "living", reason: "caravan_held", side: "caravan" });
    // The (live) party owner's side moved too — account-level siege — and their party is untouched.
    const job = await getJob(pool, `encounter:${tripId}:1`);
    const owner = (job!.input as { partyOwnerAccountId: string }).partyOwnerAccountId;
    const ownerRep = (await eventsOf(owner, "reputation_changed")).filter((e) => e.causation_id === `progression:${job!.id}`);
    expect(ownerRep.length).toBe(1);
    expect(ownerRep[0]!.caravan_id).toBeNull();
    expect(ownerRep[0]!.payload).toMatchObject({ pool: "siege", side: "party" });
    const served = (await eventsOf(owner, "party_served_as_encounter")).filter((e) => e.causation_id === job!.id);
    expect(served[0]!.payload).toMatchObject({ tripId, encounterIndex: 1, outcome: { kind: "caravan_held", depth: 512 } });
    expect(served[0]!.payload).toHaveProperty("partyHash");
  });

  it("the next party is not served until the player decides: search and commit for 2 are refused", async () => {
    const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/2/search`);
    expect(s.statusCode).toBe(409);
    expect(s.json().error).toBe("decide_first");
    const c = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/2/commit`);
    expect(c.statusCode).toBe(409);
  });

  it("the stakes preview itemizes exactly what is at risk, and that the next encounter is harder", async () => {
    const p = await preview(d);
    const m = await survivors(d);
    expect(p).toMatchObject({ tripId, encountersSurvived: 1, decisionOpen: true, decisionFor: 1 });
    expect(p.unbankedCoin).toEqual({ total: coinForEncounter(1, BAND), byEncounter: [{ index: 1, coin: coinForEncounter(1, BAND) }] });
    expect(p.bankNow).toMatchObject({ encounterCoin: coinForEncounter(1, BAND), deliveryBonus: coinForDelivery(1), total: coinForBankedTrip(1, BAND) });
    expect(p.bankNow!.forecast.prospectiveEarn).toBe(coinForBankedTrip(1, BAND));
    expect(p.units.length).toBe(3);
    for (const u of p.units) {
      const mu = m.units.find((x) => x.ref === u.ref)!;
      expect(u).toEqual({ ref: mu.ref, typeId: mu.typeId, mergeLevel: mu.mergeLevel, hp: mu.hp, maxHp: mu.maxHp, damage: mu.maxHp - mu.hp, alive: true, diedAtEncounter: null, mergeLevelOnDeath: Math.max(1, mu.mergeLevel - 1) });
    }
    // Levels come from the manifest: L2 riders drop to 1, the L1 digger stays at 1 (floor).
    expect(p.units.find((u) => u.ref === d.rider)!.mergeLevelOnDeath).toBe(1);
    expect(p.units.find((u) => u.ref === d.digger)!.mergeLevelOnDeath).toBe(1);
    expect(p.ifOverrun.coinLost).toBe(coinForEncounter(1, BAND));
    expect(p.ifOverrun.unitsLostOutright.map((u) => u.ref).sort()).toEqual([d.rider, d.digger, d.third].sort());
    expect(p.ifOverrun.unitsDeMergedNotDestroyed).toEqual([]);
    expect(p.traps.remaining.map((t) => t.ref)).toEqual(["t1", "t2"]);
    expect(p.traps.spent.map((t) => t.ref)).toEqual(["t0"]);
    expect(p.fences.intact.length).toBe(6);
    expect(p.fences.destroyed).toEqual([]);
    expect(p.nextEncounter).toEqual({
      index: 2,
      reward: coinForEncounter(2, BAND),
      band: BAND,
      bankTotalIfSurvived: coinForBankedTrip(2, BAND),
      difficulty: { escalationApplied: escalationFor(2), risePerEncounter: ESCALATION_PER_ENCOUNTER, harderThanThisEncounter: true },
      partyArrivesFresh: true,
    });
    expect(p.nextEncounter.reward).toBeGreaterThan(coinForEncounter(1, BAND));
    expect(p.lastOpponent?.encounterIndex).toBe(1);
    expect(p.lastOpponent?.reputation).toHaveProperty("gapBeyondBand");
    expect(p.lastOpponent?.reputation).toHaveProperty("sandbagEarnMultiplier");
    expect(p.rules).toMatchObject({ noRepairBetweenEncounters: true, safetyBonusForPushing: false, bankOfferedOnlyAfterSurviving: true });
  });

  it("push is binding and idempotent; a stale decision for another encounter is refused", async () => {
    const r = await push(d, tripId, 1);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ tripId, pushedPast: 1, nextEncounter: 2, replayed: false });
    expect((await push(d, tripId, 1)).json().replayed).toBe(true);
    const lateBank = await bank(d, tripId, 1);
    expect(lateBank.statusCode).toBe(409);
    expect(lateBank.json().error).toBe("already_pushed");
    expect((await status(d)).trip).toMatchObject({ phase: "arranging", currentEncounter: 2 });
  });

  it("encounter 2 held with a death: the dead unit stays dead and is unpostable; HP never rises; the spent trap stays spent", async () => {
    const s = await encounter(d, 2, { kind: "caravan_held", kill: [d.third], unitDamage: 2, spendTraps: 1 });
    expect(s.trip).toMatchObject({ phase: "decide", decisionFor: 2, unbankedCoin: coinForEncountersSurvived(2, BAND) });
    expect(s.trip!.encounters[1]).toMatchObject({ index: 2, deaths: [d.third], coinAccrued: coinForEncounter(2, BAND) });
    const m = await survivors(d);
    expect(m.units.find((u) => u.ref === d.third)!.hp).toBe(0);
    expect(m.traps.map((t) => t.spent)).toEqual([true, true, false]); // t0 spent at 1 is still spent at 2; t1 spent at 2
    const p = await preview(d);
    expect(p.units.find((u) => u.ref === d.third)).toMatchObject({ alive: false, diedAtEncounter: 2, mergeLevelOnDeath: 1 });
    expect(p.ifOverrun.unitsDeMergedNotDestroyed.map((u) => u.ref)).toEqual([d.third]);
    expect(p.ifOverrun.unitsLostOutright.map((u) => u.ref)).not.toContain(d.third);
    expect((await push(d, tripId, 2)).statusCode).toBe(200);
  });

  it("encounter 3: a spent trap or a dead unit cannot be placed; a resolver that heals or re-arms is refused before anything is recorded", async () => {
    await searchAndChoose(d, 3);
    const m = await survivors(d);
    const legal = arrangement(m);
    const usingSpent = { ...legal, traps: [...legal.traps, { ref: "t0", cell: { x: RING_ANCHORS[0]!.x + 2, y: RING_ANCHORS[0]!.y + 3 } }] };
    expect((await call(d, "PUT", `/caravans/${d.caravanId}/encounters/3/formation`, usingSpent)).statusCode).toBe(400);
    const postingDead = { ...legal, posts: [...legal.posts, { ref: d.third, cell: { x: RING_ANCHORS[0]!.x + 3, y: RING_ANCHORS[0]!.y + 3 }, stance: "guard" }] };
    expect((await call(d, "PUT", `/caravans/${d.caravanId}/encounters/3/formation`, postingDead)).statusCode).toBe(400);
    const jobId = await arrangeAndCommit(d, 3);

    // A tampering resolver that heals a unit back to full: the job parks; nothing moves.
    const heal: EncounterPlan = { kind: "caravan_held", tamper: (o) => ({ ...o, units: o.units.map((u) => ({ ...u, hp: u.hp + 1 })) }) };
    await worker(doubleHandlers({ 3: heal }));
    expect((await getJob(pool, jobId))!.status).toBe("parked");
    // (No trip read here: since chunk 15 QA D3 a read of a parked encounter VOIDS the trip — its
    // own describe below. This test requeues the job by hand instead, as an operator would.)
    expect(await survivors(d)).toEqual(m);
    // Re-armed trap / an unplaced trap: same.
    await pool.query("SELECT resolution_job_requeue($1, 3, 'test')", [jobId]);
    await worker(doubleHandlers({ 3: { kind: "caravan_held", tamper: (o) => ({ ...o, spentTraps: ["t0"] }) } }));
    expect((await getJob(pool, jobId))!.status).toBe("parked");
    expect(await survivors(d)).toEqual(m);

    // An honest resolution: nothing rises from encounter 2 to 3, everything spent stays spent.
    await pool.query("SELECT resolution_job_requeue($1, 3, 'test')", [jobId]);
    await worker(doubleHandlers({ 3: { kind: "stalemate", unitDamage: 1, spendTraps: 1 } }));
    const s = await status(d);
    expect(s.trip).toMatchObject({ phase: "decide", decisionFor: 3, unbankedCoin: coinForEncountersSurvived(3, BAND) });
    expect(s.trip!.encounters[2]).toMatchObject({ outcome: "stalemate", coinAccrued: coinForEncounter(3, BAND) });
    const after = await survivors(d);
    for (const u of after.units) expect(u.hp).toBeLessThanOrEqual(m.units.find((x) => x.ref === u.ref)!.hp);
    expect(after.units.find((u) => u.ref === d.third)!.hp).toBe(0);
    expect(after.traps.every((t) => t.spent)).toBe(true);
    for (const f of after.fences) expect(f.hp).toBeLessThanOrEqual(m.fences.find((x) => x.ref === f.ref)!.hp);
  });

  it("the resolution is deterministic: replaying the job's handler yields byte-identical events", async () => {
    const job = await getJob(pool, `encounter:${tripId}:2`);
    expect((await verifyJobReplay(pool, doubleHandlers({ 2: { kind: "caravan_held", kill: [d.third], unitDamage: 2, spendTraps: 1 } }), job!.id)).ok).toBe(true);
  });

  it("bank after a stalemate credits creditBankedTrip exactly once (retry and a concurrent double bank included), refits, and returns to town", async () => {
    const balance0 = (await pool.query("SELECT coin_balance FROM account WHERE id = $1", [d.accountId])).rows[0].coin_balance as number;
    const results = await Promise.all([bank(d, tripId, 3), bank(d, tripId, 3), bank(d, tripId, 3)]);
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect(results.map((r) => r.json().replayed).sort()).toEqual([false, true, true]);
    const winner = results.find((r) => !r.json().replayed)!.json();
    expect(winner).toMatchObject({ tripId, encountersSurvived: 3, requested: coinForBankedTrip(3, BAND), credited: coinForBankedTrip(3, BAND), discarded: 0 });
    // Chunk 19: the unit that died at encounter 2 is de-merged L2 → L1 by the bank itself.
    expect(winner.restored.deMerged).toEqual([{ ref: d.third, typeId: "desert.dust_rider", fromLevel: 2, toLevel: 1, diedAtEncounter: 2 }]);
    expect(winner.restored.trapsRestocked).toBe(3);
    expect(winner.restored.fenceSegmentsRebuilt).toBe(6);
    expect(winner.restored.unitsHealed.length).toBe(3);
    const coin = await tripCoinEvents(d.accountId, tripId);
    expect(coin.map((e) => [e.payload["reason"], e.payload["amount"]])).toEqual([
      ["encounter_survived", coinForEncounter(1, BAND)],
      ["encounter_survived", coinForEncounter(2, BAND)],
      ["encounter_survived", coinForEncounter(3, BAND)],
      ["trip_banked", coinForDelivery(3)],
    ]);
    const balance1 = (await pool.query("SELECT coin_balance FROM account WHERE id = $1", [d.accountId])).rows[0].coin_balance as number;
    expect(balance1 - balance0).toBe(coinForBankedTrip(3, BAND));
    expect((await eventsOf(d.accountId, "trip_banked")).length).toBe(1);
    expect((await caravanRow(d)).state).toBe("in_town");
    const trip = await pool.query("SELECT ended_at, end_reason FROM trip WHERE id = $1", [tripId]);
    expect(trip.rows[0].end_reason).toBe("banked");
    expect((await call(d, "GET", `/caravans/${d.caravanId}/manifest`)).statusCode).toBe(404); // closed
    expect((await status(d)).trip).toMatchObject({ id: tripId, phase: "ended", endReason: "banked", unbankedCoin: 0 });
    // After the bank nothing is decidable any more.
    expect((await push(d, tripId, 3)).json().error).toBe("trip_banked");
    expect((await call(d, "GET", `/me/caravans/${d.caravanId}/trip/preview`)).statusCode).toBe(404);
  });

  it("the refit: the next trip packs at full HP and fully restocked; a new trip starts with an immediate (un-gated) search", async () => {
    await pack(d);
    const fresh = await survivors(d);
    for (const u of fresh.units) expect(u.hp).toBe(u.maxHp);
    expect(fresh.traps.every((t) => !t.spent)).toBe(true);
    for (const f of fresh.fences) expect(f.hp).toBe(f.maxHp);
    // Chunk 19: the unit that died on the banked trip packs one level lower; the others unchanged.
    expect(fresh.units.find((u) => u.ref === d.third)!.mergeLevel).toBe(1);
    expect(fresh.units.find((u) => u.ref === d.rider)!.mergeLevel).toBe(2);
    await start(d);
    const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
    expect(s.statusCode, s.body).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("bank and push guards", () => {
  it("bank is offered only after surviving: refused before encounter 1, while resolving, and for a foreign or unknown trip", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    const early = await bank(d, tripId, 1);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("not_survived");
    expect((await push(d, tripId, 1)).json().error).toBe("not_survived");
    await searchAndChoose(d, 1);
    await arrangeAndCommit(d, 1);
    expect((await bank(d, tripId, 1)).json().error).toBe("not_survived"); // resolving: not survived yet
    expect((await status(d)).trip).toMatchObject({ phase: "resolving", currentEncounter: 1 });
    const other = await makeDefender();
    expect((await bank(other, tripId, 1)).statusCode).toBe(404);
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/bank`, { tripId, encounterIndex: 1, coin: 99 })).statusCode).toBe(400);
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/bank`, { tripId: "x", encounterIndex: 1 })).statusCode).toBe(400);
  });

  it("bank racing push: exactly one wins, the other is refused, and the ledger shows only the winner", async () => {
    for (let round = 0; round < 3; round++) {
      const d = await makeDefender();
      await pack(d);
      const tripId = await start(d);
      await encounter(d, 1, { kind: "caravan_held" });
      const [b, p] = await Promise.all([bank(d, tripId, 1), push(d, tripId, 1)]);
      const codes = [b.statusCode, p.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      const banked = b.statusCode === 200;
      expect((await tripCoinEvents(d.accountId, tripId)).length).toBe(banked ? 2 : 0);
      const te = await pool.query("SELECT decision FROM trip_encounter WHERE trip_id = $1", [tripId]);
      expect(te.rows[0].decision).toBe(banked ? "banked" : "pushed");
      expect((await caravanRow(d)).state).toBe(banked ? "in_town" : "on_trip");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("overrun ends the trip (chunk 19 applies the losses in the same transaction; detail in stakes.test.ts)", () => {
  it("records the typed hand-off, credits the defender nothing, returns the caravan to town; died → de-merged, alive → destroyed", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held", kill: [d.digger] });
    expect((await push(d, tripId, 1)).statusCode).toBe(200);
    const roster0 = (await pool.query("SELECT id, unit_type_id, merge_level FROM unit_instance WHERE caravan_id = $1 ORDER BY id", [d.caravanId])).rows;
    const balance0 = (await pool.query("SELECT coin_balance FROM account WHERE id = $1", [d.accountId])).rows[0].coin_balance;
    const s = await encounter(d, 2, { kind: "caravan_overrun", unitDamage: 4 });
    expect(s.caravan.state).toBe("in_town");
    expect(s.trip).toMatchObject({ id: tripId, phase: "ended", endReason: "overrun" });
    expect(s.trip!.encounters[1]).toMatchObject({ outcome: "caravan_overrun", depth: FIXED_ONE, coinAccrued: 0, decision: null });
    const [ev] = await eventsOf(d.accountId, "trip_overrun");
    expect(ev!.caravan_id).toBe(d.caravanId);
    expect(ev!.payload).toMatchObject({
      tripId,
      encounterIndex: 2,
      unbankedCoin: coinForEncounter(1, BAND),
      lossesApplied: true,
      partyOwnerAuthored: false,
      unitsDiedOnTrip: [{ ref: d.digger, typeId: "desert.well_digger", mergeLevel: 1, diedAtEncounter: 1 }],
    });
    expect((ev!.payload["unitsAliveAtCollapse"] as { ref: string }[]).map((u) => u.ref).sort()).toEqual([d.rider, d.third].sort());
    expect(await tripCoinEvents(d.accountId, tripId)).toEqual([]);
    expect((await pool.query("SELECT coin_balance FROM account WHERE id = $1", [d.accountId])).rows[0].coin_balance).toBe(balance0);
    // The digger (died at 1, L1) stays at the floor and comes home; rider and third (alive at the collapse) are gone.
    const roster1 = (await pool.query("SELECT id, unit_type_id, merge_level FROM unit_instance WHERE caravan_id = $1 ORDER BY id", [d.caravanId])).rows;
    expect(roster1).toEqual(roster0.filter((r: { id: string }) => r.id !== d.rider && r.id !== d.third));
    expect((await bank(d, tripId, 2)).json().error).toBe("trip_overrun");
    expect((await bank(d, tripId, 1)).statusCode).toBe(409);
    expect((await call(d, "GET", `/caravans/${d.caravanId}/manifest`)).statusCode).toBe(404);
  });

  it("an overrun on the very first encounter: nothing accrued, nothing at stake beyond the packed loadout", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    const s = await encounter(d, 1, { kind: "caravan_overrun" });
    expect(s.trip).toMatchObject({ phase: "ended", endReason: "overrun" });
    const [ev] = await eventsOf(d.accountId, "trip_overrun");
    expect(ev!.payload).toMatchObject({ tripId, unbankedCoin: 0, unitsDiedOnTrip: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("settling is exactly once under retries and races", () => {
  it("ten concurrent settles of one completed job write one trip_encounter row, one fold, one set of progression events", async () => {
    const d = await makeDefender();
    await pack(d);
    await start(d);
    await searchAndChoose(d, 1);
    await arrangeAndCommit(d, 1);
    // Retrying the commit is a no-op that returns the same job.
    const again = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/1/commit`);
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    await worker(doubleHandlers({ 1: { kind: "caravan_held", unitDamage: 3 } }));
    const caravan = await caravanRow(d);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => settleEncounter(appRole, caravan)));
    const settled = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof settleEncounter>>>).value);
    expect(settled.filter((s) => s.state === "settled" && s.created).length).toBe(1);
    const tripId = (await status(d)).trip!.id;
    expect((await pool.query("SELECT count(*)::int AS n FROM trip_encounter WHERE trip_id = $1", [tripId])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT encounters_resolved FROM wagon_manifest WHERE caravan_id = $1 AND closed_at IS NULL", [d.caravanId])).rows[0].encounters_resolved).toBe(1);
    expect((await eventsOf(d.accountId, "reputation_changed")).length).toBe(1);
    const m = await survivors(d);
    expect(m.units.every((u) => u.hp === u.maxHp - 3)).toBe(true);
    // Draining again finds nothing to do; the completed job is never re-resolved.
    expect(await worker(doubleHandlers({ 1: { kind: "caravan_overrun" } }))).toEqual([]);
  });

  it("the DB refuses a second settle, an out-of-order settle, a changed outcome or a second decision (app role)", async () => {
    const row = (await pool.query("SELECT * FROM trip_encounter ORDER BY settled_at LIMIT 1")).rows[0];
    expect((await expectDbError(appRole, "UPDATE trip_encounter SET coin_accrued = coin_accrued + 1 WHERE trip_id = $1 AND encounter_index = $2", [row.trip_id, row.encounter_index]))?.message).toMatch(/immutable/);
    expect((await expectDbError(appRole, "DELETE FROM trip_encounter WHERE trip_id = $1", [row.trip_id]))?.message).toMatch(/history/);
    expect(
      (await expectDbError(appRole, "INSERT INTO trip_encounter (trip_id, encounter_index, job_id, outcome_kind, depth_fp, deaths, coin_accrued, party_owner_account_id) VALUES ($1, 9, 'x', 'caravan_held', 0, '[]', 0, $2)", [row.trip_id, row.party_owner_account_id]))
        ?.message,
    ).toMatch(/pushed past|has ended/);
    const decided = (await pool.query("SELECT * FROM trip_encounter WHERE decision IS NOT NULL LIMIT 1")).rows[0];
    expect((await expectDbError(appRole, "UPDATE trip_encounter SET decision = CASE decision WHEN 'banked' THEN 'pushed' ELSE 'banked' END WHERE trip_id = $1 AND encounter_index = $2", [decided.trip_id, decided.encounter_index]))?.message).toMatch(/final/);
    expect((await expectDbError(appRole, "UPDATE trip_encounter SET decision = NULL, decided_at = NULL WHERE trip_id = $1 AND encounter_index = $2", [decided.trip_id, decided.encounter_index]))?.message).toMatch(/final/);
    const ended = (await pool.query("SELECT id FROM trip WHERE end_reason = 'banked' LIMIT 1")).rows[0];
    expect((await expectDbError(appRole, "UPDATE trip SET end_reason = 'overrun' WHERE id = $1", [ended.id]))?.message).toMatch(/frozen/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the production handler is wired (chunk 13)", () => {
  it("a trip-loop job carries formation, survivors (top level, QA-15 N3) and the content stamp (S3), and DEFAULT_HANDLERS resolves and settles it", async () => {
    expect(ENCOUNTER_RESOLUTION_WIRED).toBe(true);
    const d = await makeDefender();
    await pack(d);
    await start(d);
    await searchAndChoose(d, 1);
    const jobId = await arrangeAndCommit(d, 1);
    const job = await getJob(pool, jobId);
    const input = job!.input as Record<string, unknown>;
    expect(Object.keys(input.formation as object).sort()).toEqual(["fences", "posts", "traps", "v"]);
    expect(Object.keys(input).sort()).toEqual(["contentHash", "defenderAccountId", "defenderCaravanId", "encounterIndex", "formation", "party", "partyLootFull", "partyOwnerAccountId", "resolverVersion", "survivors", "tripId"]);
    expect(input.survivors).toEqual(before1(await survivors(d)));
    await worker(DEFAULT_HANDLERS);
    expect((await getJob(pool, jobId))!.status).toBe("completed");
    const s = await status(d);
    expect(s.trip!.encountersResolved).toBe(1);
    expect(await pool.query("SELECT 1 FROM encounter_log WHERE job_id = $1", [jobId]).then((r) => r.rowCount)).toBe(1);
  });
});

/** The survivors as the manifest shows them before encounter 1 (canonical JSON view). */
function before1(m: ManifestJson): unknown {
  return JSON.parse(JSON.stringify(m));
}

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("authored (system-owned) opponents: the party side resolves nothing", () => {
  it("no ledger event of any kind lands on the system account for the outcome; the caravan side resolves in full", async () => {
    await seedAuthoredParties(appRole);
    // A defender far from every live owner, so the menu is authored.
    const d = await makeDefender();
    await pool.query("UPDATE pool_progress SET reputation = 4000 WHERE caravan_id = $1 AND pool = 'living'", [d.caravanId]);
    await pack(d);
    const tripId = await start(d);
    const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
    expect(s.statusCode, s.body).toBe(201);
    const authored = (s.json().menu.candidates as { candidateId: string; owner: { authored: boolean } }[]).find((c) => c.owner.authored);
    expect(authored).toBeDefined();
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: authored!.candidateId })).statusCode).toBe(200);
    const jobId = await arrangeAndCommit(d, 1);
    const owner = ((await getJob(pool, jobId))!.input as { partyOwnerAccountId: string }).partyOwnerAccountId;
    expect((await pool.query("SELECT is_system FROM account WHERE id = $1", [owner])).rows[0].is_system).toBe(true);
    const ownerEvents0 = await eventsOf(owner);
    await worker(doubleHandlers({ 1: { kind: "caravan_held" } }));
    await status(d);
    const ownerEvents1 = await eventsOf(owner);
    const added = ownerEvents1.slice(ownerEvents0.length).map((e) => e.event_type);
    // Only the served-party feed entry (chunk 09) — no Reputation, ladder, unlock or Coin event.
    expect(added).toEqual(["party_served_as_encounter"]);
    expect((await eventsOf(d.accountId, "reputation_changed")).length).toBe(1);
    expect((await bank(d, tripId, 1)).statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("no geography, no route, no travel timer; no asynchronous attack on a caravan", () => {
  it("the trip loop's source carries no map / route / travel concepts", () => {
    const dir = join(HERE, "../src/trip");
    const files = [...readdirSync(dir).map((f) => join(dir, f)), join(HERE, "../src/routes/trip.ts")];
    for (const f of files) {
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\b(travel\w*|geograph\w*|overworld|journey\w*|destination|waypoint\w*|routeId|mapId|eta|distanceTo\w*|leg)\b/i);
    }
  });

  it("the only server path that resolves an encounter against a caravan needs that caravan's own open trip and commit", () => {
    // Every enqueue of an encounter resolution goes through enqueueChosenEncounter, which
    // requires the defender's open trip and chosen candidate; the trip loop is its only caller.
    const src = join(HERE, "../src");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (readFileSync(p, "utf8").includes("enqueueChosenEncounter(")) hits.push(p.slice(src.length));
      }
    };
    walk(src);
    expect(hits.sort()).toEqual(["/matchmaking/service.ts", "/trip/service.ts"]);
  });
});
