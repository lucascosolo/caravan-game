/**
 * Chunk 15 QA fixes (after chunk 13 wired the resolver): S4 settle at resolution (also chunk 19
 * QA S3) with the party owner's loot credited — one coherent owner-pay rule (a hold pays
 * depth-scaled loot, an overrun pays the transfer + party win, a stalemate pays nothing; never
 * twice, never to a system owner, capped by the owner's headroom); D3 the void path and the
 * `resolver_unavailable` start refusal; S6 tripId validation; N2 the preview before the first
 * survival; N4 the raw formation-commit route gated; N5 a replayed bank's balance; N7 the DB tie
 * between a trip and its trip-cap use.
 */
import { RING_ANCHORS, RING_SEGMENTS, entryBand, type Formation, type PartyConfig } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import type { CaravanRow } from "../src/db/types.js";
import { appendCoinCredits, coinForBankedTrip, coinForEncounter, readCoinBalance } from "../src/economy/coin.js";
import { getJob } from "../src/jobs/queue.js";
import { drain, type HandlerRegistry } from "../src/jobs/worker.js";
import type { LedgerEventRow } from "../src/ledger/events.js";
import { seedAuthoredParties } from "../src/matchmaking/authored.js";
import { bandOf } from "../src/matchmaking/band.js";

const BAND = bandOf(1000).index;
import { findCaravanById } from "../src/repo/caravans.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { readTripCap } from "../src/trip/cap.js";
import { partyLoot } from "../src/trip/loot.js";
import { TRIP_SETTLE_HOOKS, encounterResolverAvailable, startTrip, type StakesPreview, type TripStatusView } from "../src/trip/service.js";
import { chosenEncounterTerms, transferCausationId } from "../src/trip/stakes.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";
import { doubleHandlers, type EncounterPlan } from "../src/dev/tripDouble.js";


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

async function searchAndChoose(d: Player, n: number, pick: (c: { candidateId: string; owner: { authored: boolean } }[]) => string = (cs) => cs.find((c) => !c.owner.authored)!.candidateId): Promise<void> {
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
const hooked = (handlers: HandlerRegistry, errors: unknown[] = []) =>
  drain(pool, { workerId: "qa15-hooked", handlers, retryBackoffMs: () => 0, ...TRIP_SETTLE_HOOKS, onHookError: (e) => errors.push(e) });

async function balanceOf(accountId: string): Promise<number> {
  return (await readCoinBalance(pool, accountId)).balance;
}

async function ownerOf(jobId: string): Promise<string> {
  return ((await getJob(pool, jobId))!.input as { partyOwnerAccountId: string }).partyOwnerAccountId;
}

async function byCause(causationId: string): Promise<LedgerEventRow[]> {
  return (await pool.query<LedgerEventRow>("SELECT * FROM ledger_event WHERE causation_id = $1 ORDER BY causation_seq", [causationId])).rows;
}

async function tripRow(tripId: string): Promise<{ ended_at: Date | null; end_reason: string | null }> {
  return (await pool.query("SELECT ended_at, end_reason FROM trip WHERE id = $1", [tripId])).rows[0];
}

describe("S4: the worker settles in its completion transaction; the owner is paid with no defender read", () => {
  it("a hold: settled at resolution, the owner credited exactly the reported depth-scaled loot at the chosen row's band, and progression applied", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await searchAndChoose(d, 1);
    const jobId = await arrangeAndCommit(d, 1);
    const owner = await ownerOf(jobId);
    const before = await balanceOf(owner);
    const errors: unknown[] = [];
    await hooked(doubleHandlers({ 1: { kind: "caravan_held", depth: 700 } }), errors);
    expect(errors).toEqual([]);
    // No trip read has happened: the settle ran with the completion.
    const row = (await pool.query("SELECT * FROM trip_encounter WHERE trip_id = $1 AND encounter_index = 1", [tripId])).rows[0];
    expect(row).toMatchObject({ outcome_kind: "caravan_held", depth_fp: 700 });
    const full = coinForEncounter(1, (await chosenEncounterTerms(pool, tripId, 1)).band);
    const job = (await getJob(pool, jobId))!;
    expect((job.input as { partyLootFull: number }).partyLootFull).toBe(full);
    const loot = partyLoot("caravan_held", 700, full);
    expect(loot).toBeGreaterThan(0);
    expect((job.result as { outcome: { loot: number } }).outcome.loot).toBe(loot);
    const served = (await byCause(jobId)).find((e) => e.event_type === "party_served_as_encounter")!;
    expect(served.payload["outcome"]).toMatchObject({ kind: "caravan_held", loot });
    const credits = await byCause(transferCausationId(jobId));
    expect(credits.map((e) => [e.event_type, e.account_id, e.payload["reason"], e.payload["amount"]])).toEqual([["coin_earned", owner, "party_loot", loot]]);
    expect(await balanceOf(owner)).toBe(before + loot);
    // Chunk 04's progression for the owner landed at resolution too (siege fielded).
    expect((await byCause(`progression:${jobId}`)).some((e) => e.account_id === owner)).toBe(true);
    // A later read settles nothing new and credits nothing new.
    const s = await status(d);
    expect(s.trip).toMatchObject({ phase: "decide", decisionFor: 1 });
    expect(await byCause(transferCausationId(jobId))).toHaveLength(1);
    expect(await balanceOf(owner)).toBe(before + loot);
  });

  it("an owner at their storage cap: the loot is clamped and the discarded part recorded", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await searchAndChoose(d, 1);
    const jobId = await arrangeAndCommit(d, 1);
    const owner = await ownerOf(jobId);
    const { balance, cap } = await readCoinBalance(pool, owner);
    // Leave 5 Coin of room.
    await withTransaction(pool, (c) => appendCoinCredits(c, { causationId: `test:${unique("bal")}`, accountId: owner, credits: [{ amount: cap - 5 - balance, reason: "test_setup" }] }));
    await hooked(doubleHandlers({ 1: { kind: "caravan_held", depth: FIXED_DEPTH } }));
    const loot = partyLoot("caravan_held", FIXED_DEPTH, coinForEncounter(1, (await chosenEncounterTerms(pool, tripId, 1)).band));
    expect(loot).toBeGreaterThan(5);
    const [credit] = await byCause(transferCausationId(jobId));
    expect(credit!.payload).toMatchObject({ reason: "party_loot", amount: 5, overflowDiscarded: loot - 5 });
    expect(await balanceOf(owner)).toBe(cap);
    // Retire this capped owner from the pool: later tests draw from the twelve owners by seed
    // (random trip ids), and one that drew an owner with no headroom would see its credits
    // clamped (the overrun test's transfer + party win). Siege 0 is beyond ±WIDTH_MAX of every
    // centre searched in this file.
    await pool.query("UPDATE pool_progress SET reputation = 0 WHERE account_id = $1 AND pool = 'siege'", [owner]);
  });

  it("an overrun pays the transfer + party win and NO loot; a stalemate pays the owner nothing", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await searchAndChoose(d, 1);
    const j1 = await arrangeAndCommit(d, 1);
    await hooked(doubleHandlers({ 1: { kind: "stalemate" } }));
    expect((await getJob(pool, j1))!.result).toMatchObject({ outcome: { kind: "stalemate", loot: 0 } });
    expect(await byCause(transferCausationId(j1))).toEqual([]);
    expect((await push(d, tripId, 1)).statusCode).toBe(200);
    await searchAndChoose(d, 2);
    const j2 = await arrangeAndCommit(d, 2);
    const owner2 = await ownerOf(j2);
    const before = await balanceOf(owner2);
    await hooked(doubleHandlers({ 2: { kind: "caravan_overrun" } }));
    expect((await getJob(pool, j2))!.result).toMatchObject({ outcome: { kind: "caravan_overrun", loot: 0 } });
    expect(await tripRow(tripId)).toMatchObject({ end_reason: "overrun" });
    const credits = await byCause(transferCausationId(j2));
    const unbanked = coinForEncounter(1, BAND);
    expect(credits.map((e) => [e.event_type, e.payload["reason"], e.payload["amount"]])).toEqual([
      ["coin_transferred_to_party_owner", "caravan_overrun", unbanked],
      ["coin_earned", "party_win", TUNABLES.COIN_PER_PARTY_WIN],
    ]);
    expect(await balanceOf(owner2)).toBe(before + unbanked + TUNABLES.COIN_PER_PARTY_WIN);
  });

  it("a system (authored) owner: the reported loot is 0 and nothing is credited, at resolution or later", async () => {
    await seedAuthoredParties(appRole);
    try {
      const d = await makeDefender();
      await pool.query("UPDATE pool_progress SET reputation = 4000 WHERE caravan_id = $1 AND pool = 'living'", [d.caravanId]);
      await pack(d);
      const tripId = await start(d);
      await searchAndChoose(d, 1, (cs) => cs.find((c) => c.owner.authored)!.candidateId);
      const jobId = await arrangeAndCommit(d, 1);
      const job = (await getJob(pool, jobId))!;
      expect((job.input as { partyLootFull: number }).partyLootFull).toBe(0);
      await hooked(doubleHandlers({ 1: { kind: "caravan_held", depth: 1000 } }));
      expect((await getJob(pool, jobId))!.result).toMatchObject({ outcome: { kind: "caravan_held", loot: 0 } });
      expect(await byCause(transferCausationId(jobId))).toEqual([]);
      expect((await pool.query("SELECT 1 FROM trip_encounter WHERE trip_id = $1", [tripId])).rowCount).toBe(1);
    } finally {
      // Retire the authored set again (owner role, as the suite's per-file reset does). The later
      // tests' default pick is "the first live candidate", and with 96 authored parties in the
      // pool a seeded draw (random trip ids) can serve three authored parties, leaving no live
      // candidate to pick. Later tests draw from the twelve live owners the beforeAll made.
      await pool.query("DELETE FROM account WHERE is_system");
    }
  });

  it("a settle that fails inside the worker is rolled back alone: the resolution commits and the lazy settle still folds it once", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await searchAndChoose(d, 1);
    const jobId = await arrangeAndCommit(d, 1);
    const errors: unknown[] = [];
    await drain(pool, {
      workerId: "qa15-failing-hook",
      handlers: doubleHandlers({ 1: { kind: "caravan_held" } }),
      retryBackoffMs: () => 0,
      afterCompleted: async (client, job) => {
        await TRIP_SETTLE_HOOKS.afterCompleted(client, job);
        throw new Error("injected settle failure");
      },
      onHookError: (e) => errors.push(e),
    });
    expect(errors.map(String)).toEqual(["Error: injected settle failure"]);
    expect((await getJob(pool, jobId))!.status).toBe("completed");
    expect((await pool.query("SELECT 1 FROM trip_encounter WHERE trip_id = $1", [tripId])).rowCount).toBe(0);
    expect(await byCause(transferCausationId(jobId))).toEqual([]);
    expect((await status(d)).trip).toMatchObject({ phase: "decide", decisionFor: 1 });
    expect((await pool.query("SELECT 1 FROM trip_encounter WHERE trip_id = $1", [tripId])).rowCount).toBe(1);
    expect(await byCause(transferCausationId(jobId))).toHaveLength(1);
  });
});

const FIXED_DEPTH = 900;

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("D3: the void path", () => {
  it("encounter 1 parks: the trip is voided on the next read, nothing credited, nothing lost, the cap use not refunded", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    const capAfterStart = await readTripCap(pool, d.accountId, Date.now());
    await searchAndChoose(d, 1);
    const jobId = await arrangeAndCommit(d, 1);
    const unitsBefore = (await pool.query("SELECT id, merge_level FROM unit_instance WHERE caravan_id = $1 ORDER BY id", [d.caravanId])).rows;
    const balanceBefore = await balanceOf(d.accountId);
    // A tampering resolver (heals): non-retryable → parked. No hooks: the lazy read voids it.
    await worker(doubleHandlers({ 1: { kind: "caravan_held", tamper: (o) => ({ ...o, units: o.units.map((u) => ({ ...u, hp: u.hp + 1 })) }) } }));
    expect((await getJob(pool, jobId))!.status).toBe("parked");
    const s = await status(d);
    expect(s.caravan.state).toBe("in_town");
    expect(s.trip).toMatchObject({ id: tripId, phase: "ended", endReason: "voided", encountersResolved: 0, unbankedCoin: 0 });
    expect(s.trip!.ending).toMatchObject({ kind: "voided", voidedEncounter: 1, encountersSurvived: 0, credited: 0 });
    expect((s.trip!.ending as { reason: string }).reason).toMatch(/refused|rise|heal|hp/i);
    const [ev] = await byCause(`trip:${tripId}:voided`);
    expect(ev).toMatchObject({ event_type: "trip_voided", account_id: d.accountId, caravan_id: d.caravanId });
    expect(ev!.payload).toMatchObject({ voidedEncounter: 1, jobId, encountersSurvived: 0, credited: 0, tripCapRefunded: false });
    expect(await balanceOf(d.accountId)).toBe(balanceBefore);
    expect((await pool.query("SELECT id, merge_level FROM unit_instance WHERE caravan_id = $1 ORDER BY id", [d.caravanId])).rows).toEqual(unitsBefore);
    expect((await pool.query("SELECT 1 FROM trip_encounter WHERE trip_id = $1", [tripId])).rowCount).toBe(0);
    expect((await pool.query("SELECT closed_at FROM wagon_manifest WHERE id = $1", [s.trip!.manifestId])).rows[0].closed_at).not.toBeNull();
    // The cap use stays spent (nothing refunds it).
    expect((await readTripCap(pool, d.accountId, Date.now())).available).toBeLessThanOrEqual(capAfterStart.available);
    // Idempotent: another read changes nothing; a decision is refused.
    await status(d);
    expect(await byCause(`trip:${tripId}:voided`)).toHaveLength(1);
    expect((await bank(d, tripId, 1)).statusCode).toBe(409);
  });

  it("encounter 2 parks with the worker hooks: voided at once, banked as of encounter 1 (stored Coin + delivery), its death de-merged as a bank would", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await searchAndChoose(d, 1);
    await arrangeAndCommit(d, 1);
    await hooked(doubleHandlers({ 1: { kind: "caravan_held", kill: [d.third] } }));
    expect((await push(d, tripId, 1)).statusCode).toBe(200);
    await searchAndChoose(d, 2);
    const j2 = await arrangeAndCommit(d, 2);
    const balanceBefore = await balanceOf(d.accountId);
    const errors: unknown[] = [];
    await hooked(doubleHandlers({ 2: { kind: "caravan_held", tamper: (o) => ({ ...o, units: o.units.map((u) => ({ ...u, hp: u.hp + 1 })) }) } }), errors);
    expect(errors).toEqual([]);
    expect((await getJob(pool, j2))!.status).toBe("parked");
    // No read yet: the worker's park hook voided it.
    expect(await tripRow(tripId)).toMatchObject({ end_reason: "voided" });
    const [ev] = await byCause(`trip:${tripId}:voided`);
    const want = coinForBankedTrip(1, BAND);
    expect(ev!.payload).toMatchObject({ voidedEncounter: 2, encountersSurvived: 1, requested: want, credited: want, discarded: 0, balanceAfter: balanceBefore + want, tripCapRefunded: false });
    expect((ev!.payload["restored"] as { deMerged: unknown[] }).deMerged).toEqual([{ ref: d.third, typeId: "desert.dust_rider", fromLevel: 2, toLevel: 1, diedAtEncounter: 1 }]);
    expect(await balanceOf(d.accountId)).toBe(balanceBefore + want);
    expect((await pool.query("SELECT merge_level FROM unit_instance WHERE id = $1", [d.third])).rows[0].merge_level).toBe(1);
    // The bank's own causation carries the credit: a later bank can never pay again.
    expect((await byCause(`trip:${tripId}:bank`)).map((e) => e.payload["reason"])).toEqual(["encounter_survived", "trip_banked"]);
    expect((await bank(d, tripId, 1)).statusCode).toBe(409);
    expect(await balanceOf(d.accountId)).toBe(balanceBefore + want);
    // Nothing of the voided fight reached its party's owner.
    expect(await byCause(transferCausationId(j2))).toEqual([]);
    expect(await byCause(`progression:${j2}`)).toEqual([]);
  });

  it("trip start is refused 409 resolver_unavailable only when no resolver can take the encounter; the double counts as available", async () => {
    expect(encounterResolverAvailable(false, false)).toBe(false);
    expect(encounterResolverAvailable(true, false)).toBe(true); // CARAVAN_TEST_RESOLVER=double (pnpm e2e)
    expect(encounterResolverAvailable(false, true)).toBe(true); // chunk 13: wired
    expect(encounterResolverAvailable(false)).toBe(true); // ENCOUNTER_RESOLUTION_WIRED is true
    const d = await makeDefender();
    await pack(d);
    const capBefore = await readTripCap(pool, d.accountId, 1_000_000);
    const caravan = (await findCaravanById(pool, d.caravanId)) as CaravanRow;
    await expect(withTransaction(appRole, (c) => startTrip(c, caravan, 1_000_000, { resolverAvailable: false }))).rejects.toMatchObject({ statusCode: 409, code: "resolver_unavailable" });
    expect(await readTripCap(pool, d.accountId, 1_000_000)).toEqual(capBefore);
    expect((await pool.query("SELECT 1 FROM trip WHERE caravan_id = $1", [d.caravanId])).rowCount).toBe(0);
    // A running app with the test double installed starts trips.
    const withDouble = await buildApp({ db: appRole, inlineEncounterWorker: { name: "test-double", handlers: doubleHandlers({}), delayMs: 60_000 } });
    try {
      const r = await withDouble.inject({ method: "POST", url: `/me/caravans/${d.caravanId}/trip/start`, headers: { authorization: `Bearer ${d.token}` } });
      expect(r.statusCode, r.body).toBe(201);
    } finally {
      await withDouble.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("S6 / N2 / N4 / N5", () => {
  it("S6: a tripId that is not a UUID is a 400 on push and bank", async () => {
    const d = await makeDefender();
    for (const tripId of ["-".repeat(36), "0".repeat(36), `${"a".repeat(32)}----`, "x"]) {
      for (const r of [await push(d, tripId, 1), await bank(d, tripId, 1)]) {
        expect(r.statusCode, tripId).toBe(400);
        expect(r.json().error).toBe("bad_body");
      }
    }
  });

  it("N2: before the first survived encounter the preview omits bankNow and harderThanThisEncounter; after it, both are present", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    const p0 = await preview(d);
    expect(p0.encountersSurvived).toBe(0);
    expect(p0).not.toHaveProperty("bankNow");
    expect(p0.nextEncounter.difficulty).not.toHaveProperty("harderThanThisEncounter");
    await searchAndChoose(d, 1);
    await arrangeAndCommit(d, 1);
    await hooked(doubleHandlers({ 1: { kind: "caravan_held" } }));
    const p1 = await preview(d);
    expect(p1.bankNow).toBeDefined();
    expect(p1.nextEncounter.difficulty.harderThanThisEncounter).toBe(true);
    expect(tripId).toBe(p1.tripId);
  });

  it("N4: the raw formation-commit route refuses in town and before a candidate is chosen; inside the trip loop it freezes", async () => {
    const d = await makeDefender();
    await pack(d);
    const m = await survivors(d);
    expect((await call(d, "PUT", `/caravans/${d.caravanId}/encounters/1/formation`, arrangement(m))).statusCode).toBe(200);
    const raw = () => call(d, "POST", `/caravans/${d.caravanId}/encounters/1/formation/commit`);
    let r = await raw();
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("no_trip");
    await start(d);
    r = await raw();
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("no_candidate_chosen");
    await searchAndChoose(d, 1);
    r = await raw();
    expect(r.statusCode, r.body).toBe(200);
    // The trip loop's commit then queues exactly that frozen formation.
    const c = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/1/commit`);
    expect(c.statusCode, c.body).toBe(202);
    // Leave no job in flight for later files (chunk 02's sweeps count them).
    await hooked(doubleHandlers({ 1: { kind: "caravan_held" } }));
    expect((await getJob(pool, c.json().jobId))!.status).toBe("completed");
  });

  it("N5: a retried bank returns the balance the bank left (stored in trip_banked), marked replayed", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await searchAndChoose(d, 1);
    await arrangeAndCommit(d, 1);
    await hooked(doubleHandlers({ 1: { kind: "caravan_held" } }));
    const first = await bank(d, tripId, 1);
    expect(first.statusCode, first.body).toBe(200);
    const again = await bank(d, tripId, 1);
    expect(again.statusCode).toBe(200);
    const a = first.json();
    const b = again.json();
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(typeof a.balanceAfter).toBe("number");
    expect(b.balanceAfter).toBe(a.balanceAfter);
    expect({ ...b, replayed: false }).toEqual(a);
    const [ev] = await byCause(`trip:${tripId}:banked`);
    expect(ev!.payload["balanceAfter"]).toBe(a.balanceAfter);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("N7: a trip is tied to its trip-cap use in the database (as the app role)", () => {
  it("every started trip has its cap use; forged, duplicate, edited or deleted uses are refused; a trip without one can neither settle nor end with a reason", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    const use = (await pool.query("SELECT * FROM trip_cap_use WHERE trip_id = $1", [tripId])).rows[0];
    const tat = (await pool.query("SELECT tat_ms FROM trip_cap WHERE account_id = $1", [d.accountId])).rows[0].tat_ms;
    expect(use).toMatchObject({ account_id: d.accountId, legacy: false });
    expect(Number(use.tat_ms)).toBe(Number(tat));
    expect((await expectDbError(appRole, "UPDATE trip_cap_use SET tat_ms = tat_ms + 1 WHERE trip_id = $1", [tripId]))?.message).toMatch(/immutable/);
    expect((await expectDbError(appRole, "DELETE FROM trip_cap_use WHERE trip_id = $1", [tripId]))?.message).toMatch(/may not be deleted/);
    expect((await expectDbError(appRole, "TRUNCATE trip_cap_use"))).not.toBeNull();

    // A trip created outside the trip loop (chunk 14's bare seam) has no use: it cannot be given one by hand...
    const e = await makeDefender();
    await pack(e);
    const manifestId = (await pool.query("SELECT id FROM wagon_manifest WHERE caravan_id = $1 AND closed_at IS NULL", [e.caravanId])).rows[0].id;
    const bare = (await appRole.query("INSERT INTO trip (caravan_id, manifest_id) VALUES ($1, $2) RETURNING id", [e.caravanId, manifestId])).rows[0].id as string;
    expect((await expectDbError(appRole, "INSERT INTO trip_cap_use (trip_id, account_id, tat_ms) VALUES ($1, $2, 123)", [bare, e.accountId]))?.message).toMatch(/trip cap stands at/);
    expect((await expectDbError(appRole, "INSERT INTO trip_cap_use (trip_id, account_id, tat_ms) VALUES ($1, $2, $3)", [bare, d.accountId, tat]))?.message).toMatch(/is not a trip of account/);
    expect((await expectDbError(appRole, "INSERT INTO trip_cap_use (trip_id, account_id, tat_ms, legacy) VALUES ($1, $2, NULL, true)", [bare, e.accountId]))?.message).toMatch(/legacy/);
    // ...cannot be settled, and cannot end with a trip-loop reason.
    expect(
      (await expectDbError(appRole, "INSERT INTO trip_encounter (trip_id, encounter_index, job_id, outcome_kind, depth_fp, deaths, coin_accrued, party_owner_account_id) VALUES ($1, 1, 'x', 'caravan_held', 0, '[]', 0, $2)", [bare, d.accountId]))?.message,
    ).toMatch(/no recorded trip-cap use/);
    expect((await expectDbError(appRole, "UPDATE trip SET ended_at = now(), end_reason = 'banked' WHERE id = $1", [bare]))?.message).toMatch(/no recorded trip-cap use/);
    // Two trips can never share one use (the second start's tat is strictly later; a copy is refused).
    expect((await expectDbError(appRole, "INSERT INTO trip_cap_use (trip_id, account_id, tat_ms) VALUES ($1, $2, $3)", [tripId, d.accountId, tat]))).not.toBeNull();
    await appRole.query("UPDATE trip SET ended_at = now() WHERE id = $1", [bare]);
  });
});
