/**
 * Chunk 19 — stakes and loss. The consequences of a trip, wired into chunk 15's seams and
 * driven end to end through the routes with the deterministic resolver double:
 *
 *   - per-death de-merge (one level, floored at 1) on EVERY death, banked or overrun;
 *   - total loss of the units still alive when the caravan falls — and the INVERSION: a unit
 *     that died earlier (or in the final fight) is de-merged and comes home, never destroyed;
 *   - all unbanked Coin lost on an overrun and transferred to the overrunning party's owner,
 *     capped by their headroom (excess destroyed), destroyed outright for a system owner;
 *   - the earn floor (`applyEarnFloor`, one apply site) reading the chosen candidate's
 *     multiplier;
 *   - the attacking party's owner loses nothing; unlocks / ladders / granted points untouched;
 *   - the bank-or-push preview equals what bank and overrun then do;
 *   - exactly once under retries, a failed partial commit, and two racing transfers to one
 *     recipient;
 *   - the rebuild cost of a worst-case collapse (recorded in the chunk file).
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
import { appendCoinCredits, coinForEncounter, readCoinBalance } from "../src/economy/coin.js";
import { getJob } from "../src/jobs/queue.js";
import { drain, type HandlerRegistry } from "../src/jobs/worker.js";
import type { LedgerEventRow } from "../src/ledger/events.js";
import { appendEvents } from "../src/ledger/ledger.js";
import { seedAuthoredParties } from "../src/matchmaking/authored.js";
import { bandOf } from "../src/matchmaking/band.js";
import { chosenCandidate } from "../src/matchmaking/service.js";
import { findCaravanById } from "../src/repo/caravans.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { hasAccess } from "../src/unlocks/access.js";
import { bankTrip, settleEncounter, stakesPreview, type StakesPreview } from "../src/trip/service.js";
import { redactForeignAccountIds } from "../src/routes/ledger.js";
import { applyEarnFloor, chosenEncounterTerms, mergeLevelAfterDeath, planUnitLosses, transferCausationId } from "../src/trip/stakes.js";
import { partyLoot } from "../src/trip/loot.js";
import { appRolePool, testPool, truncateAll, unique } from "./helpers.js";
import { rebuildMixed, rebuildPlan, weeklyFreeEarn } from "../../../scripts/balance/model.js";
import { doubleHandlers, type EncounterPlan } from "../src/dev/tripDouble.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "../src");
const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Fixtures (the same shapes as trip.test.ts)
// ─────────────────────────────────────────────────────────────────────────────────────────

interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  units: string[];
}

async function registerPlayer(region = "desert"): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("s"), password: "correct horse battery", region } });
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

async function makeOwner(siegeRep: number): Promise<Player> {
  const p = await registerPlayer("desert");
  await giveUnits(p, 3, "desert.dust_rider", 2);
  expect((await call(p, "PUT", "/me/party", fullParty(p.units))).statusCode).toBe(200);
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [p.accountId, siegeRep]);
  return p;
}

/**
 * An "island": three owners at one siege rating, at least 400 from every other party in the
 * world, so a defender searching at that rating gets exactly these three in the menu and the
 * test can pick the one it wants. Returns the owners and the rating.
 */
const islandRating = new Map<string, number>();
let nextIsland = 1600;
async function makeIsland(): Promise<{ rating: number; owners: Player[] }> {
  const rating = nextIsland;
  nextIsland += 400;
  const owners = [await makeOwner(rating), await makeOwner(rating), await makeOwner(rating)];
  for (const o of owners) islandRating.set(o.accountId, rating);
  return { rating, owners };
}

interface Defender extends Player {
  /** dust_rider L3, packed */
  a: string;
  /** dust_rider L2, packed */
  b: string;
  /** well_digger L1, packed */
  c: string;
  /** two dust_rider L1 left in town, never packed */
  town: string[];
}

const GENERAL_RATING = 1000;
/** Chunk 19 QA D2a: the display band encounter Coin scales with, for a defender searching at GENERAL_RATING (it holds, so it stays in band 3). */
const BAND = bandOf(GENERAL_RATING).index;

async function makeDefender(): Promise<Defender> {
  const p = await registerPlayer("desert");
  const [a] = await giveUnits(p, 1, "desert.dust_rider", 3);
  const [b] = await giveUnits(p, 1, "desert.dust_rider", 2);
  const [c] = await giveUnits(p, 1, "desert.well_digger", 1);
  const town = await giveUnits(p, 2, "desert.dust_rider", 1);
  await setLiving(p, GENERAL_RATING);
  return { ...p, a: a!, b: b!, c: c!, town };
}

async function setLiving(p: Player, rating: number): Promise<void> {
  await pool.query("UPDATE pool_progress SET reputation = $2 WHERE caravan_id = $1 AND pool = 'living'", [p.caravanId, rating]);
}

async function pack(d: Defender): Promise<void> {
  const res = await call(d, "POST", `/caravans/${d.caravanId}/manifest`, { units: [d.a, d.b, d.c], traps: ["trap.spike_pit", "trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 4 } });
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

/** Search at the right rating, then choose `ownerId`'s party (or the first candidate). */
async function searchAndChoose(d: Player, n: number, ownerId?: string): Promise<void> {
  if (ownerId) await setLiving(d, islandRating.get(ownerId)!);
  const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/search`);
  expect(s.statusCode, s.body).toBe(201);
  let candidateId: string = s.json().menu.candidates[0].candidateId;
  if (ownerId) {
    const row = await pool.query<{ id: string }>(
      `SELECT c->>'candidateId' AS id FROM encounter_candidates ec CROSS JOIN LATERAL jsonb_array_elements(ec.candidates) c
        WHERE ec.trip_id = $1 AND ec.encounter_index = $2 AND c->'owner'->>'accountId' = $3 ORDER BY ec.search_seq DESC LIMIT 1`,
      [s.json().menu.tripId ?? (await openTripId(d)), n, ownerId],
    );
    expect(row.rows[0], `owner ${ownerId} is not in the menu for encounter ${n}`).toBeDefined();
    candidateId = row.rows[0]!.id;
  }
  const ch = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/choose`, { candidateId });
  expect(ch.statusCode, ch.body).toBe(200);
}

async function openTripId(d: Player): Promise<string> {
  return (await pool.query<{ id: string }>("SELECT id FROM trip WHERE caravan_id = $1 AND ended_at IS NULL", [d.caravanId])).rows[0]!.id;
}

async function arrangeAndCommit(d: Player, n: number): Promise<string> {
  const f = await call(d, "PUT", `/caravans/${d.caravanId}/encounters/${n}/formation`, arrangement(await survivors(d)));
  expect(f.statusCode, f.body).toBe(200);
  const c = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/${n}/commit`);
  expect([200, 202], c.body).toContain(c.statusCode);
  return c.json().jobId;
}

const worker = (handlers: HandlerRegistry) => drain(pool, { workerId: "stakes-test", handlers, retryBackoffMs: () => 0 });

/** search → choose → arrange → commit → resolve (double) → settle (via GET). */
async function encounter(d: Player, n: number, plan: EncounterPlan, ownerId?: string): Promise<void> {
  await searchAndChoose(d, n, ownerId);
  await arrangeAndCommit(d, n);
  await worker(doubleHandlers({ [n]: plan }));
  expect((await call(d, "GET", `/me/caravans/${d.caravanId}/trip`)).statusCode).toBe(200);
}

async function preview(d: Player): Promise<StakesPreview> {
  const res = await call(d, "GET", `/me/caravans/${d.caravanId}/trip/preview`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const push = async (d: Player, tripId: string, n: number) => expect((await call(d, "POST", `/me/caravans/${d.caravanId}/trip/push`, { tripId, encounterIndex: n })).statusCode).toBe(200);
const bank = (d: Player, tripId: string, n: number) => call(d, "POST", `/me/caravans/${d.caravanId}/trip/bank`, { tripId, encounterIndex: n });

async function caravanRow(d: Player): Promise<CaravanRow> {
  return (await findCaravanById(pool, d.caravanId))!;
}

async function eventsOf(accountId: string, type?: string): Promise<LedgerEventRow[]> {
  const res = await pool.query<LedgerEventRow>(`SELECT * FROM ledger_event WHERE account_id = $1${type ? " AND event_type = $2" : ""} ORDER BY seq`, type ? [accountId, type] : [accountId]);
  return res.rows;
}

async function byCausation(causationId: string): Promise<LedgerEventRow[]> {
  return (await pool.query<LedgerEventRow>("SELECT * FROM ledger_event WHERE causation_id = $1 ORDER BY causation_seq", [causationId])).rows;
}

async function roster(caravanId: string): Promise<{ id: string; unit_type_id: string; merge_level: number }[]> {
  return (await pool.query("SELECT id, unit_type_id, merge_level FROM unit_instance WHERE caravan_id = $1 ORDER BY id", [caravanId])).rows;
}

async function levelOf(id: string): Promise<number | null> {
  const r = await pool.query<{ merge_level: number }>("SELECT merge_level FROM unit_instance WHERE id = $1", [id]);
  return r.rows[0]?.merge_level ?? null;
}

async function balance(accountId: string): Promise<number> {
  return (await readCoinBalance(pool, accountId)).balance;
}

async function setBalance(accountId: string, target: number): Promise<void> {
  const now = await balance(accountId);
  if (target < now) throw new Error("setBalance only raises in this file");
  if (target === now) return;
  await withTransaction(pool, (c) => appendCoinCredits(c, { causationId: `test:${unique("bal")}`, accountId, credits: [{ amount: target - now, reason: "test_setup" }] }));
}

/** Permanent progression: what no loss may ever reduce. Reputation (volatile) is deliberately excluded. */
async function permanence(accountId: string, caravanId: string | null): Promise<{ rows: { pool: string; ladder_level: number; ladder_points: number; unlock_points_granted: number; unlock_points_spent: number }[]; nodes: string[]; grants: string[] }> {
  const rows = (
    await pool.query(
      `SELECT pool::text AS pool, ladder_level, ladder_points, unlock_points_granted, unlock_points_spent FROM pool_progress
        WHERE account_id = $1 OR caravan_id = $2 ORDER BY pool`,
      [accountId, caravanId],
    )
  ).rows;
  const nodes = (await pool.query<{ n: string }>("SELECT payload->>'nodeId' AS n FROM ledger_event WHERE account_id = $1 AND event_type = 'unlock_node_purchased' ORDER BY seq", [accountId])).rows.map((r) => r.n);
  const grants = (await pool.query<{ g: string }>("SELECT (payload->>'pool') || ':' || (payload->>'rung') AS g FROM ledger_event WHERE account_id = $1 AND event_type = 'unlock_points_granted' ORDER BY seq", [accountId])).rows.map((r) => r.g);
  return { rows, nodes, grants };
}

function expectNotReduced(before: Awaited<ReturnType<typeof permanence>>, after: Awaited<ReturnType<typeof permanence>>): void {
  expect(after.rows.map((r) => r.pool)).toEqual(before.rows.map((r) => r.pool));
  for (const b of before.rows) {
    const a = after.rows.find((r) => r.pool === b.pool)!;
    expect(a.ladder_level, `${b.pool} ladder level`).toBeGreaterThanOrEqual(b.ladder_level);
    expect(a.ladder_points, `${b.pool} ladder points`).toBeGreaterThanOrEqual(b.ladder_points);
    expect(a.unlock_points_granted, `${b.pool} granted points`).toBeGreaterThanOrEqual(b.unlock_points_granted);
    expect(a.unlock_points_spent, `${b.pool} spent points`).toBe(b.unlock_points_spent);
  }
  expect(after.nodes).toEqual(before.nodes); // nothing bought, nothing taken away
  expect(after.grants.slice(0, before.grants.length)).toEqual(before.grants);
}

/** The twelve general-pool owners (siege 950..1060) and the rating each was created at. */
const generalOwners: { owner: Player; rating: number }[] = [];

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });
  for (let i = 0; i < 12; i++) generalOwners.push({ owner: await makeOwner(950 + i * 10), rating: 950 + i * 10 });
});
afterAll(async () => {
  await app.close();
  await appRole.end();
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("pure rules", () => {
  it("applyEarnFloor is floor(coin × m / FIXED_ONE) on integers and refuses anything else", () => {
    expect(applyEarnFloor(400, FIXED_ONE)).toBe(400);
    expect(applyEarnFloor(400, 256)).toBe(100);
    expect(applyEarnFloor(781, 256)).toBe(195); // 781 × 0.25 = 195.25 → 195
    expect(applyEarnFloor(0, 300)).toBe(0);
    expect(applyEarnFloor(999, 0)).toBe(0);
    for (const [c, m] of [[-1, FIXED_ONE], [1.5, FIXED_ONE], [400, FIXED_ONE + 1], [400, -1], [400, 0.5]] as const) expect(() => applyEarnFloor(c, m)).toThrow(RangeError);
  });

  it("a death costs exactly one level, floored at 1: a unit is never erased by de-merging alone", () => {
    expect(TUNABLES.DEMERGE_LEVELS_PER_DEATH).toBe(1);
    expect([1, 2, 3, 4, 5].map(mergeLevelAfterDeath)).toEqual([1, 1, 2, 3, 4]);
    let l = 5;
    for (let i = 0; i < 20; i++) l = mergeLevelAfterDeath(l);
    expect(l).toBe(1);
  });

  it("planUnitLosses is the inversion: dead → de-merged (bank and overrun alike), alive → destroyed only on an overrun", () => {
    const m = {
      v: 1,
      units: [
        { ref: "dead2", typeId: "x", mergeLevel: 3, hp: 0, maxHp: 10 },
        { ref: "alive", typeId: "x", mergeLevel: 4, hp: 3, maxHp: 10 },
        { ref: "dead1", typeId: "y", mergeLevel: 1, hp: 0, maxHp: 10 },
      ],
      traps: [],
      fences: [],
    } as unknown as Parameters<typeof planUnitLosses>[0];
    const rows = [{ encounter_index: 1, deaths: ["dead1"] }, { encounter_index: 2, deaths: ["dead2"] }] as unknown as Parameters<typeof planUnitLosses>[1];
    expect(planUnitLosses(m, rows, "overrun")).toEqual({
      deMerged: [
        { ref: "dead2", typeId: "x", fromLevel: 3, toLevel: 2, diedAtEncounter: 2 },
        { ref: "dead1", typeId: "y", fromLevel: 1, toLevel: 1, diedAtEncounter: 1 },
      ],
      destroyed: [{ ref: "alive", typeId: "x", mergeLevel: 4, hp: 3 }],
    });
    expect(planUnitLosses(m, rows, "banked").destroyed).toEqual([]);
    expect(planUnitLosses(m, rows, "banked").deMerged).toEqual(planUnitLosses(m, rows, "overrun").deMerged);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the inversion through a real overrun: died → de-merged, survived to the collapse → destroyed", () => {
  it("unit b dies at encounter 2, a and c survive to the collapse at 3: b comes home one level down, a and c are gone; the preview said exactly this", async () => {
    const { owners } = await makeIsland();
    const recipient = owners[0]!;
    const d = await makeDefender();
    await setBalance(d.accountId, 1_234); // banked Coin from before: never at risk
    const townBefore = (await roster(d.caravanId)).filter((r) => d.town.includes(r.id));
    const permBefore = await permanence(d.accountId, d.caravanId);
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held", unitDamage: 2 });
    await push(d, tripId, 1);
    await encounter(d, 2, { kind: "caravan_held", kill: [d.b] });
    const p = await preview(d);
    await push(d, tripId, 2);
    const recipientBefore = await balance(recipient.accountId);
    await encounter(d, 3, { kind: "caravan_overrun" }, recipient.accountId);

    // Units: b died at 2 → de-merged L2 → L1 and still on the roster; a (L3) and c (L1) alive at the collapse → destroyed.
    expect(await levelOf(d.b)).toBe(1);
    expect(await levelOf(d.a)).toBeNull();
    expect(await levelOf(d.c)).toBeNull();
    // The roster left in town: byte-identical.
    expect((await roster(d.caravanId)).filter((r) => d.town.includes(r.id))).toEqual(townBefore);
    expect((await roster(d.caravanId)).map((r) => r.id).sort()).toEqual([d.b, ...d.town].sort());
    // Banked Coin: untouched; unbanked Coin: lost.
    const unbanked = coinForEncounter(1, BAND) + coinForEncounter(2, BAND);
    expect(await balance(d.accountId)).toBe(1_234);

    const batch = await byCausation(`trip:${tripId}:overrun`);
    expect(batch.map((e) => e.event_type)).toEqual(["trip_overrun", "unit_demerged_on_death", "unit_lost_on_wipe", "unit_lost_on_wipe", "coin_lost_on_wipe"]);
    expect(batch.every((e) => e.account_id === d.accountId && e.caravan_id === d.caravanId)).toBe(true);
    expect(batch[1]!.payload).toMatchObject({ unitInstanceId: d.b, fromLevel: 2, toLevel: 1, floored: false, diedAtEncounter: 2, tripEnd: "overrun" });
    expect(batch.slice(2, 4).map((e) => [e.payload["unitInstanceId"], e.payload["mergeLevel"]])).toEqual([[d.a, 3], [d.c, 1]]);
    expect(batch[4]!.payload).toMatchObject({ amount: unbanked, transferred: unbanked, destroyed: 0, destroyedReason: "none" });
    const handoff = batch[0]!.payload as { lossesApplied: boolean; losses: { deMerged: unknown[]; destroyed: unknown[]; coin: Record<string, unknown> } };
    expect(handoff.lossesApplied).toBe(true);

    // The preview at the last decision named exactly these losses (no unit died in the final fight).
    expect(handoff.losses.deMerged).toEqual(p.ifOverrun.unitsDeMergedNotDestroyed);
    expect(handoff.losses.destroyed).toEqual(p.ifOverrun.unitsLostOutright);
    expect(handoff.losses.coin["lost"]).toBe(p.ifOverrun.coinLost);
    expect(p.ifOverrun.coinLost).toBe(unbanked);

    // The recipient: exactly the lost amount, credited once, account-scoped, under transfer:<job>,
    // then the party-win credit in the same batch (chunk 19 QA D1).
    const jobId = `encounter:${tripId}:3`;
    const transfer = await byCausation(transferCausationId(jobId));
    expect(transfer.map((e) => e.event_type)).toEqual(["coin_transferred_to_party_owner", "coin_earned"]);
    expect(transfer[0]).toMatchObject({ event_type: "coin_transferred_to_party_owner", account_id: recipient.accountId, caravan_id: null });
    expect(transfer[0]!.payload).toMatchObject({ amount: unbanked, reason: "caravan_overrun", jobId, tripId, encounterIndex: 3 });
    expect(transfer[1]).toMatchObject({ account_id: recipient.accountId, caravan_id: null });
    expect(transfer[1]!.payload).toMatchObject({ amount: TUNABLES.COIN_PER_PARTY_WIN, reason: "party_win", jobId, tripId, encounterIndex: 3 });
    expect(handoff.losses.coin["partyWin"]).toEqual({ amount: TUNABLES.COIN_PER_PARTY_WIN, credited: TUNABLES.COIN_PER_PARTY_WIN, discarded: 0 });
    expect(await balance(recipient.accountId)).toBe(recipientBefore + unbanked + TUNABLES.COIN_PER_PARTY_WIN);

    // Unlock rights and ladder progress: not reduced by any of it; the destroyed types stay re-acquirable.
    expectNotReduced(permBefore, await permanence(d.accountId, d.caravanId));
    const owner = { accountId: d.accountId, caravanId: d.caravanId };
    expect(await hasAccess(pool, owner, "desert.dust_rider")).toBe(true);
    expect(await hasAccess(pool, owner, "desert.well_digger")).toBe(true);
    // No progression event was written by the loss itself.
    expect(batch.some((e) => /reputation|ladder|unlock/.test(e.event_type))).toBe(false);
    expect((await caravanRow(d)).state).toBe("in_town");
  });

  it("a unit that dies IN the fight the caravan falls in is de-merged, not destroyed (the preview names this exception)", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held" });
    const p = await preview(d);
    expect(p.ifOverrun.unitDyingInTheFinalFight).toBe("de_merged_not_destroyed");
    expect(p.ifOverrun.unitsLostOutright.map((u) => u.ref).sort()).toEqual([d.a, d.b, d.c].sort());
    await push(d, tripId, 1);
    await encounter(d, 2, { kind: "caravan_overrun", kill: [d.a] });
    expect(await levelOf(d.a)).toBe(2); // L3, died at 2 → L2, kept
    expect(await levelOf(d.b)).toBeNull();
    expect(await levelOf(d.c)).toBeNull();
    const demerges = (await eventsOf(d.accountId, "unit_demerged_on_death")).map((e) => e.payload);
    expect(demerges).toEqual([expect.objectContaining({ unitInstanceId: d.a, fromLevel: 3, toLevel: 2, diedAtEncounter: 2, tripEnd: "overrun" })]);
    expect((await eventsOf(d.accountId, "unit_lost_on_wipe")).map((e) => e.payload["unitInstanceId"]).sort()).toEqual([d.b, d.c].sort());
  });

  it("an overrun with nothing unbanked (first encounter) transfers nothing but still pays the party win, destroys what was alive, and records a zero loss", async () => {
    const { owners } = await makeIsland();
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    const before = await eventsOf(owners[0]!.accountId);
    const coinBefore = await balance(owners[0]!.accountId);
    await encounter(d, 1, { kind: "caravan_overrun" }, owners[0]!.accountId);
    // Chunk 19 QA D1: every overrun by a player-owned party pays COIN_PER_PARTY_WIN, even when the caravan carried nothing.
    const xfer = await byCausation(transferCausationId(`encounter:${tripId}:1`));
    expect(xfer.map((e) => [e.event_type, e.payload["reason"], e.payload["amount"]])).toEqual([["coin_earned", "party_win", TUNABLES.COIN_PER_PARTY_WIN]]);
    expect(await balance(owners[0]!.accountId)).toBe(coinBefore + TUNABLES.COIN_PER_PARTY_WIN);
    const after = await eventsOf(owners[0]!.accountId);
    expect(after.slice(before.length).map((e) => e.event_type).filter((t) => t.startsWith("coin"))).toEqual(["coin_earned"]);
    const lost = await eventsOf(d.accountId, "coin_lost_on_wipe");
    expect(lost.map((e) => e.payload)).toEqual([expect.objectContaining({ amount: 0, transferred: 0, destroyed: 0, destroyedReason: "none" })]);
    expect((await roster(d.caravanId)).map((r) => r.id).sort()).toEqual([...d.town].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("per-death de-merge on a BANKED trip, and the bank preview equals the bank", () => {
  it("every unit that died is de-merged once by the bank (retry and concurrent banks included); survivors keep their level; the preview matched", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held", kill: [d.a] });
    await push(d, tripId, 1);
    await encounter(d, 2, { kind: "stalemate", kill: [d.c] });
    const p = await preview(d);
    expect(p.bankNow!.unitsDeMerged).toEqual([
      { ref: d.a, typeId: "desert.dust_rider", fromLevel: 3, toLevel: 2, diedAtEncounter: 1 },
      { ref: d.c, typeId: "desert.well_digger", fromLevel: 1, toLevel: 1, diedAtEncounter: 2 },
    ]);
    const before = await balance(d.accountId);
    const results = await Promise.all([bank(d, tripId, 2), bank(d, tripId, 2), bank(d, tripId, 2)]);
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    const winner = results.map((r) => r.json()).find((b) => !b.replayed)!;
    expect(winner.restored.deMerged).toEqual(p.bankNow!.unitsDeMerged);
    expect(winner.requested).toBe(p.bankNow!.total);
    expect(winner.credited + winner.discarded).toBe(p.bankNow!.total);
    expect(await balance(d.accountId)).toBe(before + p.bankNow!.forecast.wouldCredit);
    // De-merged exactly once despite three banks.
    expect(await levelOf(d.a)).toBe(2);
    expect(await levelOf(d.c)).toBe(1); // floored
    expect(await levelOf(d.b)).toBe(2); // survived: untouched
    const ev = await eventsOf(d.accountId, "unit_demerged_on_death");
    expect(ev.map((e) => [e.payload["unitInstanceId"], e.payload["fromLevel"], e.payload["toLevel"], e.payload["floored"], e.payload["tripEnd"]])).toEqual([
      [d.a, 3, 2, false, "banked"],
      [d.c, 1, 1, true, "banked"],
    ]);
    expect(ev.every((e) => e.causation_id === `trip:${tripId}:banked`)).toBe(true);
    // Nothing destroyed on a bank, no Coin lost.
    expect(await eventsOf(d.accountId, "unit_lost_on_wipe")).toEqual([]);
    expect(await eventsOf(d.accountId, "coin_lost_on_wipe")).toEqual([]);
  });

  it("a level-1 unit dying on trip after trip is never erased by de-merging alone", async () => {
    const d = await makeDefender();
    for (let trip = 0; trip < 3; trip++) {
      await pack(d);
      const tripId = await start(d);
      await encounter(d, 1, { kind: "caravan_held", kill: [d.c] });
      expect((await bank(d, tripId, 1)).statusCode).toBe(200);
      expect(await levelOf(d.c)).toBe(1);
    }
    expect((await eventsOf(d.accountId, "unit_demerged_on_death")).every((e) => e.payload["floored"] === true)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the Coin transfer is capped by the recipient's headroom", () => {
  it("a recipient at 99% of the cap takes only its headroom; the excess is destroyed and recorded on both sides", async () => {
    const { owners } = await makeIsland();
    const r = owners[0]!;
    const cap = TUNABLES.COIN_STORAGE_CAP;
    await setBalance(r.accountId, (cap * 99) / 100); // 49,500: 500 of room
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held" });
    await push(d, tripId, 1);
    await encounter(d, 2, { kind: "caravan_held" });
    await push(d, tripId, 2);
    await encounter(d, 3, { kind: "caravan_overrun" }, r.accountId);
    const lost = coinForEncounter(1, BAND) + coinForEncounter(2, BAND); // 1000 + 1347 at band 3
    expect(await balance(r.accountId)).toBe(cap);
    const [t, win] = await byCausation(transferCausationId(`encounter:${tripId}:3`));
    expect(t!.payload).toMatchObject({ amount: 500, overflowDiscarded: lost - 500 });
    // The party win comes after the transfer in the same clamp: no room is left for it, all recorded (QA D1).
    expect(win!.payload).toMatchObject({ amount: 0, reason: "party_win", overflowDiscarded: TUNABLES.COIN_PER_PARTY_WIN });
    const [l] = await eventsOf(d.accountId, "coin_lost_on_wipe");
    expect(l!.payload).toMatchObject({ amount: lost, transferred: 500, destroyed: lost - 500, destroyedReason: "recipient_storage_cap" });
  });

  it("two overruns settling at once into one recipient: the cap holds for both, each transfer once, the sum reconciles", async () => {
    const { owners } = await makeIsland();
    const r = owners[0]!;
    const cap = TUNABLES.COIN_STORAGE_CAP;
    await setBalance(r.accountId, cap - 1_000);
    const ds = [await makeDefender(), await makeDefender()];
    const trips: string[] = [];
    for (const d of ds) {
      await pack(d);
      const tripId = await start(d);
      trips.push(tripId);
      await encounter(d, 1, { kind: "caravan_held" });
      await push(d, tripId, 1);
      await encounter(d, 2, { kind: "caravan_held" });
      await push(d, tripId, 2);
    }
    // Commit encounter 3 for both against the same recipient (after every earlier drain, so
    // no other plan resolves them), resolve both, and only then settle.
    for (const d of ds) {
      await searchAndChoose(d, 3, r.accountId);
      await arrangeAndCommit(d, 3);
    }
    await worker(doubleHandlers({ 3: { kind: "caravan_overrun" } }));
    const caravans = await Promise.all(ds.map(caravanRow));
    // Each caravan settled four times concurrently, both caravans at once.
    const results = await Promise.allSettled(caravans.flatMap((c) => Array.from({ length: 4 }, () => settleEncounter(appRole, c))));
    for (const res of results) if (res.status === "rejected") expect(String(res.reason)).toMatch(/trip_moved|changed while/);
    // A settle that lost the race may have been refused (trip_moved); the read path settles lazily, so read once more.
    for (const c of caravans) await settleEncounter(appRole, c);
    const lostEach = coinForEncounter(1, BAND) + coinForEncounter(2, BAND);
    const transfers = (await Promise.all(trips.map((t) => byCausation(transferCausationId(`encounter:${t}:3`))))).map((x) => {
      expect(x.map((e) => e.event_type)).toEqual(["coin_transferred_to_party_owner", "coin_earned"]);
      // Both batches ran against a full store by the time the party win was reached: it is discarded, recorded.
      expect(x[1]!.payload).toMatchObject({ reason: "party_win" });
      return x[0]!.payload as { amount: number; overflowDiscarded?: number };
    });
    expect(transfers.reduce((s, t) => s + t.amount, 0)).toBe(1_000);
    expect(transfers.reduce((s, t) => s + t.amount + (t.overflowDiscarded ?? 0), 0)).toBe(2 * lostEach);
    expect(await balance(r.accountId)).toBe(cap);
    for (const d of ds) {
      expect((await eventsOf(d.accountId, "unit_lost_on_wipe")).length).toBe(3);
      expect((await eventsOf(d.accountId, "coin_lost_on_wipe")).length).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("exactly once: a failed commit leaves nothing; the retry applies everything once", () => {
  it("a transfer that fails mid-settle rolls back the de-merge, the destruction and the trip's end; the retry applies each once", async () => {
    const { owners } = await makeIsland();
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held", kill: [d.b] });
    await push(d, tripId, 1);
    await searchAndChoose(d, 2, owners[0]!.accountId);
    await arrangeAndCommit(d, 2);
    await worker(doubleHandlers({ 2: { kind: "caravan_overrun" } }));
    const rosterBefore = await roster(d.caravanId);
    const fn = `test_fail_transfer_${unique("f").replace(/[^a-z0-9_]/g, "")}`;
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected transfer failure'; END $$`);
    await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON ledger_event FOR EACH ROW WHEN (NEW.event_type = 'coin_transferred_to_party_owner') EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(settleEncounter(appRole, await caravanRow(d))).rejects.toThrow(/injected transfer failure/);
      expect(await roster(d.caravanId)).toEqual(rosterBefore);
      expect((await pool.query("SELECT ended_at FROM trip WHERE id = $1", [tripId])).rows[0].ended_at).toBeNull();
      expect((await pool.query("SELECT count(*)::int AS n FROM trip_encounter WHERE trip_id = $1", [tripId])).rows[0].n).toBe(1);
      expect(await byCausation(`trip:${tripId}:overrun`)).toEqual([]);
      expect((await caravanRow(d)).state).toBe("on_trip");
    } finally {
      await pool.query(`DROP TRIGGER ${fn} ON ledger_event`);
      await pool.query(`DROP FUNCTION ${fn}()`);
    }
    for (let i = 0; i < 3; i++) await settleEncounter(appRole, await caravanRow(d));
    expect(await levelOf(d.b)).toBe(1);
    expect((await eventsOf(d.accountId, "unit_demerged_on_death")).length).toBe(1);
    expect((await eventsOf(d.accountId, "unit_lost_on_wipe")).length).toBe(2);
    expect((await byCausation(transferCausationId(`encounter:${tripId}:2`))).map((e) => e.event_type)).toEqual(["coin_transferred_to_party_owner", "coin_earned"]);
    expect((await eventsOf(d.accountId, "trip_overrun")).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the attacking party's owner risks nothing", () => {
  it("served into a hold and an overrun: roster, party and GET /me/party byte-identical; permanent progression never reduced; Coin only up; the feed shows the payoff", async () => {
    const { owners } = await makeIsland();
    const o = owners[0]!;
    const unitsBefore = await roster(o.caravanId);
    const partyRowBefore = (await pool.query("SELECT * FROM standing_party WHERE account_id = $1", [o.accountId])).rows;
    const partyViewBefore = (await call(o, "GET", "/me/party")).json();
    const permBefore = await permanence(o.accountId, o.caravanId);
    const coinBefore = await balance(o.accountId);

    // A hold: the party is beaten off (and units of it "die" in the defender's fight — nothing of the owner's moves).
    const d1 = await makeDefender();
    await pack(d1);
    const t1 = await start(d1);
    await encounter(d1, 1, { kind: "caravan_held" }, o.accountId);
    expect((await bank(d1, t1, 1)).statusCode).toBe(200);
    // An overrun: the party wins and is paid.
    const d2 = await makeDefender();
    await pack(d2);
    const t2 = await start(d2);
    await encounter(d2, 1, { kind: "caravan_held" });
    await push(d2, t2, 1);
    await encounter(d2, 2, { kind: "caravan_overrun" }, o.accountId);

    expect(await roster(o.caravanId)).toEqual(unitsBefore);
    expect((await pool.query("SELECT * FROM standing_party WHERE account_id = $1", [o.accountId])).rows).toEqual(partyRowBefore);
    expect((await call(o, "GET", "/me/party")).json()).toEqual(partyViewBefore);
    expectNotReduced(permBefore, await permanence(o.accountId, o.caravanId));
    // Chunk 15 QA S4: each hold pays the owner its depth-scaled loot (the double's held depth is
    // 512) at THAT encounter's chosen-row band; the overrun pays the transfer + party win and no loot.
    const lootAt = async (tripId: string, n: number) => partyLoot("caravan_held", 512, coinForEncounter(n, (await chosenEncounterTerms(pool, tripId, n)).band));
    const loot1 = await lootAt(t1, 1);
    expect(loot1).toBeGreaterThan(0);
    // o may also have been drawn for d2's (held) encounter 1: one loot credit per hold it was served in.
    const lootCredits = (await eventsOf(o.accountId, "coin_earned")).filter((e) => e.payload["reason"] === "party_loot");
    expect(lootCredits.map((e) => e.payload["tripId"])).toContain(t1);
    let lootTotal = 0;
    for (const e of lootCredits) {
      const want = await lootAt(String(e.payload["tripId"]), Number(e.payload["encounterIndex"]));
      expect(e.payload["amount"]).toBe(want);
      lootTotal += want;
    }
    expect(await balance(o.accountId)).toBe(coinBefore + lootTotal + coinForEncounter(1, BAND) + TUNABLES.COIN_PER_PARTY_WIN);
    const ownerTypes = new Set((await eventsOf(o.accountId)).map((e) => e.event_type));
    for (const t of ["unit_demerged_on_death", "unit_lost_on_wipe", "coin_lost_on_wipe", "coin_spent", "standing_party_invalidated", "unit_retired"]) expect(ownerTypes.has(t as never), t).toBe(false);

    // The asynchronous payoff: the owner's feed names the overrun, its Coin and the job (the replay key).
    const feed = (await call(o, "GET", "/me/party/feed")).json();
    const entry = feed.entries.find((e: { jobId: string }) => e.jobId === `encounter:${t2}:2`);
    expect(entry).toMatchObject({
      outcomeKind: "caravan_overrun",
      coinEarned: coinForEncounter(1, BAND) + TUNABLES.COIN_PER_PARTY_WIN,
      coinTransferred: coinForEncounter(1, BAND),
      partyWinCoin: TUNABLES.COIN_PER_PARTY_WIN,
      lootCoin: 0,
      coinDiscardedAtCap: 0,
      tripId: t2,
      encounterIndex: 2,
    });
    // Chunk 19 QA S1: the feed names the defender by username, never by account id.
    expect(entry.defender).not.toHaveProperty("accountId");
    expect(JSON.stringify(feed)).not.toContain(d2.accountId);
    expect(feed.entries.find((e: { jobId: string }) => e.jobId === `encounter:${t1}:1`)).toMatchObject({ outcomeKind: "caravan_held", coinEarned: loot1, lootCoin: loot1, partyWinCoin: 0, coinTransferred: 0, outcome: { loot: loot1 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("unlock rights and ladder progress survive a total collapse", () => {
  it("a type reached on the web and wiped out entirely stays reached, its points stay granted and spent, and it can be acquired again", async () => {
    const { owners } = await makeIsland();
    const d = await makeDefender();
    // Reach desert.sand_sharpshooter (cost 1) with fixture-granted points, and pack the only copy.
    await withTransaction(pool, (c) => appendEvents(c, `test:grant:${d.caravanId}`, [{ type: "unlock_points_granted", accountId: d.accountId, caravanId: d.caravanId, payload: { pool: "living", points: 5, rung: 20 } }]));
    expect((await call(d, "POST", "/me/unlocks/spend", { pool: "living", nodeId: "desert.sand_sharpshooter", caravanId: d.caravanId })).statusCode).toBe(201);
    const [sharp] = await giveUnits(d, 1, "desert.sand_sharpshooter", 1);
    const res = await call(d, "POST", `/caravans/${d.caravanId}/manifest`, { units: [d.a, sharp], traps: [], fence: { tierId: "fence.brush_pile", count: 2 } });
    expect(res.statusCode, res.body).toBe(201);
    const unlocksBefore = (await call(d, "GET", "/me/unlocks")).json();
    const permBefore = await permanence(d.accountId, d.caravanId);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_overrun" }, owners[0]!.accountId);
    expect(await levelOf(sharp!)).toBeNull();
    expect((await eventsOf(d.accountId, "trip_overrun"))[0]!.payload["tripId"]).toBe(tripId);
    expectNotReduced(permBefore, await permanence(d.accountId, d.caravanId));
    const unlocksAfter = (await call(d, "GET", "/me/unlocks")).json();
    const reached = (b: { webs: { pool: string; nodes: { id: string; reached: boolean }[] }[] }) => b.webs.flatMap((w) => w.nodes.filter((n) => n.reached).map((n) => `${w.pool}:${n.id}`)).sort();
    expect(reached(unlocksAfter)).toEqual(reached(unlocksBefore));
    expect(await hasAccess(pool, { accountId: d.accountId, caravanId: d.caravanId }, "desert.sand_sharpshooter")).toBe(true);
    // Re-acquirable: the mercenary path (chunk 18) still offers it.
    await setBalance(d.accountId, 5_000);
    const merc = await call(d, "POST", `/me/caravans/${d.caravanId}/recruit`, { unitTypeId: "desert.sand_sharpshooter" });
    expect([200, 201], merc.body).toContain(merc.statusCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the defender's own standing party and a lost instance", () => {
  it("a destroyed unit the defender's party names invalidates it (standing_party_invalidated, trip_loss); a de-merged one is simply reflected", async () => {
    const { owners } = await makeIsland();
    const d = await makeDefender();
    expect((await call(d, "PUT", "/me/party", fullParty([d.a, d.b]))).statusCode).toBe(200);
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held", kill: [d.b] });
    await push(d, tripId, 1);
    await encounter(d, 2, { kind: "caravan_overrun" }, owners[0]!.accountId);
    const batch = await byCausation(`trip:${tripId}:overrun`);
    const inv = batch.find((e) => e.event_type === "standing_party_invalidated")!;
    expect(inv).toBeDefined();
    expect(inv.caravan_id).toBeNull();
    expect(inv.payload).toMatchObject({ reason: "trip_loss", removedRefs: [d.a], valid: false });
    const party = (await call(d, "GET", "/me/party")).json().party;
    expect(party.valid).toBe(false);
    expect(JSON.stringify(party.issues)).toMatch(/unknown_ref/);
    expect(await levelOf(d.b)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the earn floor: one apply site, the chosen candidate's multiplier", () => {
  it("a party the search widened to pays in full (FIXED_ONE), exactly the chosen row's multiplier", async () => {
    const d = await makeDefender();
    await setLiving(d, 1_350); // nothing within ±150: the search widens to the general pool
    // Pin the pool this premise is about. Earlier encounters in this file move the general
    // owners' siege ratings (progression at settle), and which owner each draw served depends
    // on the seed (random trip/caravan ids), so by now a third owner may have drifted from
    // 1040 into the ±150 band around the centre (1200: only 1050 and 1060 sit in it at their
    // created ratings) and the search would not widen. Put them back where they were created.
    for (const g of generalOwners) await pool.query("UPDATE pool_progress SET reputation = $2 WHERE account_id = $1 AND pool = 'siege'", [g.owner.accountId, g.rating]);
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held" });
    const widened = await pool.query<{ band_width_used: number }>("SELECT band_width_used FROM encounter_candidates WHERE trip_id = $1 AND encounter_index = 1", [tripId]);
    expect(widened.rows[0]!.band_width_used).toBeGreaterThan(TUNABLES.REPUTATION_BAND_WIDTH);
    const chosen = await chosenCandidate(pool, tripId, 1);
    expect(chosen!.reputation.sandbagEarnMultiplier).toBe(FIXED_ONE);
    const te = await pool.query("SELECT coin_accrued FROM trip_encounter WHERE trip_id = $1", [tripId]);
    expect(te.rows[0].coin_accrued).toBe(coinForEncounter(1, bandOf(1_350).index));
  });

  it("sandbagEarnMultiplier is read nowhere in src/ outside matchmaking/ but trip/stakes.ts, and applyEarnFloor is applied only there", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const files = walk(SRC).filter((f) => !f.includes(`${join(SRC, "matchmaking")}`));
    expect(files.filter((f) => /sandbagEarnMultiplier/.test(code(f))).map((f) => f.replace(SRC, ""))).toEqual(["/trip/stakes.ts"]);
    expect(files.filter((f) => /applyEarnFloor\s*\(/.test(code(f))).map((f) => f.replace(SRC, ""))).toEqual(["/trip/stakes.ts"]);
    // The loss path reads no purchase / entitlement state and no clock or randomness (GUARDRAILS §1/§2).
    const stakes = code(join(SRC, "trip/stakes.ts"));
    expect(stakes).not.toMatch(/entitle|billing|purchase|coin_purchased|\bpacks?\b|premium|subscription/i);
    expect(stakes).not.toMatch(/Math\.random|Date\.now|new Date/);
    // The single writer of the loss events.
    for (const t of ["unit_lost_on_wipe", "unit_demerged_on_death", "coin_lost_on_wipe", "coin_transferred_to_party_owner"]) {
      const writers = walk(SRC).filter((f) => new RegExp(`type:\\s*["']${t}["']`).test(code(f)));
      expect(writers.map((f) => f.replace(SRC, "")), t).toEqual(["/trip/stakes.ts"]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("generous acquisition: the real cost to rebuild after a worst-case collapse", () => {
  it("8 level-5 units destroyed: the cheapest rebuild from level 1 with the current tunables (recorded in the chunk 19 file)", () => {
    const [two, five] = [TUNABLES.MERGE_RECIPES.find((r) => r.spend === 2)!, TUNABLES.MERGE_RECIPES.find((r) => r.spend === 5)!];
    expect([two.produce, five.produce]).toEqual([1, 3]);
    // Greedy from the top: as many 5→3 batches as fit, then 2→1 for the remainder (5→3 is
    // the cheaper recipe per output: same Coin per produced unit, fewer inputs).
    let need = TUNABLES.DEPLOYMENT_SLOT_CAP; // 8 L5
    let mergeCoin = 0;
    const perLevel: number[] = [];
    for (let target = 5; target >= 2; target--) {
      const big = Math.floor(need / five.produce);
      const rest = need - big * five.produce;
      const small = Math.ceil(rest / two.produce);
      const produced = big * five.produce + small * two.produce;
      mergeCoin += produced * TUNABLES.MERGE_COST_BY_TARGET_LEVEL[target]!;
      need = big * five.spend + small * two.spend;
      perLevel.push(need);
    }
    const level1 = need;
    expect(perLevel).toEqual([14, 24, 40, 67]); // L4, L3, L2, L1 inputs needed
    expect(mergeCoin).toBe(149_600);
    expect(level1).toBe(67);
    const mercCoin = level1 * TUNABLES.MERCENARY_COST_BASE;
    expect(mercCoin).toBe(40_200);
    expect(mergeCoin + mercCoin).toBe(189_800);
    // Time: refugees are free (one per REFUGEE_REFRESH_INTERVAL_MINUTES) — 67 × 90 min ≈ 100.5 h.
    expect((level1 * TUNABLES.REFUGEE_REFRESH_INTERVAL_MINUTES) / 60).toBe(100.5);
    // Coin pace: FREE_WEEKLY_EARN_ESTIMATE (the derived MID week, chunk 19 QA D3) per week of free play.
    expect(Math.round((mergeCoin / TUNABLES.FREE_WEEKLY_EARN_ESTIMATE) * 10) / 10).toBe(2.7);
    expect(Math.round(((mergeCoin + mercCoin) / TUNABLES.FREE_WEEKLY_EARN_ESTIMATE) * 10) / 10).toBe(3.5);
    // The inventory guard never blocks the rebuild, and no single merge exceeds the storage cap.
    expect(level1).toBeLessThan(TUNABLES.UNIT_INVENTORY_CAP);
    expect(five.produce * TUNABLES.MERGE_COST_BY_TARGET_LEVEL[5]!).toBeLessThan(TUNABLES.COIN_STORAGE_CAP);
    // The balance model (scripts/balance/model.ts) runs the same math: one source for the §37 pass.
    expect(rebuildPlan(TUNABLES.DEPLOYMENT_SLOT_CAP, 5)).toMatchObject({ inputsByLevel: perLevel, level1, mergeCoin, mercenaryCoin: mercCoin, totalCoin: 189_800, refugeeHours: 100.5 });
  });

  it("QA N4: 8 level-5 units of 8 DIFFERENT types (no shared merges): 96 L1, 166,800 merge Coin, 224,400 with mercenaries", () => {
    // One unit of a type at L5: 2 L4 ← 4 L3 (5→3 + 2→1 from 7) ← 7 L2 ← 12 L1, per type.
    const one = rebuildPlan(1, 5);
    expect(one.inputsByLevel).toEqual([2, 4, 7, 12]);
    expect(one.mergeCoin).toBe(7 * 250 + 4 * 900 + 2 * 3_000 + 9_500); // 20,850
    const mixed = rebuildMixed(Array(TUNABLES.DEPLOYMENT_SLOT_CAP).fill(5));
    expect(mixed.level1).toBe(96);
    expect(mixed.mergeCoin).toBe(166_800);
    expect(mixed.mercenaryCoin).toBe(96 * TUNABLES.MERCENARY_COST_BASE);
    expect(mixed.totalCoin).toBe(224_400);
    expect(mixed.refugeeHours).toBe(144);
    expect(Math.round((mixed.mergeCoin / TUNABLES.FREE_WEEKLY_EARN_ESTIMATE) * 10) / 10).toBe(3.0);
    expect(Math.round((mixed.totalCoin / TUNABLES.FREE_WEEKLY_EARN_ESTIMATE) * 10) / 10).toBe(4.1);
  });

  it("QA D3: FREE_WEEKLY_EARN_ESTIMATE is the derived mid week (trickle + 30 trips at p1 0.65), rounded down; the range brackets it; 1.5× holds against it", () => {
    const low = weeklyFreeEarn(15, 0.6, 0.05);
    const mid = weeklyFreeEarn(30, 0.65, 0.05);
    const high = weeklyFreeEarn(42, 0.7, 0.05);
    expect(mid.trickle).toBe(33_600);
    expect(Math.floor(mid.total / 1000) * 1000).toBe(TUNABLES.FREE_WEEKLY_EARN_ESTIMATE);
    expect(low.total).toBeLessThan(mid.total);
    expect(high.total).toBeGreaterThan(mid.total);
    expect([Math.round(low.total / 100) * 100, Math.round(mid.total / 100) * 100, Math.round(high.total / 100) * 100]).toEqual([43_700, 55_500, 66_700]);
    expect(TUNABLES.WEEKLY_PAY_CEILING * 10_000).toBeLessThanOrEqual(TUNABLES.FREE_WEEKLY_EARN_ESTIMATE * TUNABLES.PAID_TO_FREE_RATIO_MAX_BP);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Chunk 19 QA round 1 (roadmap/qa/19-punchlist.md) — the reviewer's probes, as tests.
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("QA D2b: encounter 1 is matched below the caravan; escalation from 2 on is unchanged; nothing it serves is floored", () => {
  it("encounter 1's menu is centred at rating − 150 and pays every candidate in full; encounter 2 is centred at rating + 15", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    const s1 = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
    expect(s1.statusCode, s1.body).toBe(201);
    const m1 = s1.json().menu;
    expect(m1.caravan.rating).toBe(GENERAL_RATING);
    expect(m1.centre).toBe(GENERAL_RATING + TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET);
    expect(m1.escalation.applied).toBe(-150);
    expect(m1.rules.escalation.firstEncounterOffset).toBe(-150);
    for (const c of m1.candidates as { reputation: { rating: number; gapBeyondBand: number; sandbagEarnMultiplier: number } }[]) {
      expect(Math.abs(c.reputation.rating - m1.centre)).toBeLessThanOrEqual(m1.bandWidthUsed);
      expect(c.reputation.gapBeyondBand).toBe(0);
      expect(c.reputation.sandbagEarnMultiplier).toBe(FIXED_ONE);
    }
    const ch = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: m1.candidates[0].candidateId });
    expect(ch.statusCode, ch.body).toBe(200);
    await arrangeAndCommit(d, 1);
    await worker(doubleHandlers({ 1: { kind: "caravan_held" } }));
    expect((await call(d, "GET", `/me/caravans/${d.caravanId}/trip`)).statusCode).toBe(200);
    expect((await chosenCandidate(pool, tripId, 1))!.reputation.sandbagEarnMultiplier).toBe(FIXED_ONE);
    const p = await preview(d);
    expect(p.nextEncounter.difficulty).toMatchObject({ escalationApplied: TUNABLES.DIFFICULTY_ESCALATION_BP * 300 / 10_000, harderThanThisEncounter: true });
    await push(d, tripId, 1);
    const rating2 = (await pool.query<{ reputation: number }>("SELECT reputation FROM pool_progress WHERE caravan_id = $1 AND pool = 'living'", [d.caravanId])).rows[0]!.reputation;
    const s2 = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/2/search`);
    expect(s2.statusCode, s2.body).toBe(201);
    expect(s2.json().menu.centre).toBe(rating2 + 15);
    expect(s2.json().menu.escalation.applied).toBe(15);
  });
});

describe("QA D2a: encounter Coin scales with the caravan's display band, read from the chosen menu row and stored at accrual", () => {
  it("the band is the one the search was drawn at: moving the rating after choosing changes nothing; the preview's next reward is what the next encounter accrues", async () => {
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await searchAndChoose(d, 1);
    // The rating jumps three bands AFTER the menu was drawn: the accrual must not see it.
    await setLiving(d, 2_000);
    await arrangeAndCommit(d, 1);
    await worker(doubleHandlers({ 1: { kind: "caravan_held" } }));
    expect((await call(d, "GET", `/me/caravans/${d.caravanId}/trip`)).statusCode).toBe(200);
    expect(bandOf(2_000).index).toBeGreaterThan(BAND);
    const te1 = (await pool.query<{ coin_accrued: number }>("SELECT coin_accrued FROM trip_encounter WHERE trip_id = $1 AND encounter_index = 1", [tripId])).rows[0]!;
    expect(te1.coin_accrued).toBe(coinForEncounter(1, BAND)); // 1000 at band 3, not 2000's band
    expect(te1.coin_accrued).toBe(1_000);
    // The preview reads the CURRENT living band (it is what the next search will be drawn at).
    const now = (await pool.query<{ reputation: number }>("SELECT reputation FROM pool_progress WHERE caravan_id = $1 AND pool = 'living'", [d.caravanId])).rows[0]!.reputation;
    expect((await preview(d)).nextEncounter).toMatchObject({ band: bandOf(now).index, reward: coinForEncounter(2, bandOf(now).index) });
    await setLiving(d, GENERAL_RATING);
    const p = await preview(d);
    expect(p.nextEncounter).toMatchObject({ band: BAND, reward: coinForEncounter(2, BAND), bankTotalIfSurvived: 1_000 + coinForEncounter(2, BAND) + 2 * TUNABLES.COIN_DELIVERY_PER_ENCOUNTER });
    await push(d, tripId, 1);
    await encounter(d, 2, { kind: "caravan_held" });
    const te2 = (await pool.query<{ coin_accrued: number }>("SELECT coin_accrued FROM trip_encounter WHERE trip_id = $1 AND encounter_index = 2", [tripId])).rows[0]!;
    expect(te2.coin_accrued).toBe(p.nextEncounter.reward);
    // Retuning or re-rating now changes nothing already accrued: the bank credits the stored rows.
    await setLiving(d, 100);
    const b = await bank(d, tripId, 2);
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().requested).toBe(1_000 + p.nextEncounter.reward + 2 * TUNABLES.COIN_DELIVERY_PER_ENCOUNTER);
  });
});

describe("QA D1 + S1 + S2: a recipient at the cap — the party win is paid (and discarded) beside the transfer; no account id leaves the read models", () => {
  it("recipient exactly at cap: both credits recorded at 0 with overflowDiscarded; the feed shows coinDiscardedAtCap; /me/ledger carries no foreign account id", async () => {
    const { owners } = await makeIsland();
    const o = owners[0]!;
    await setBalance(o.accountId, TUNABLES.COIN_STORAGE_CAP);
    const d = await makeDefender();
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held" });
    await push(d, tripId, 1);
    await encounter(d, 2, { kind: "caravan_overrun" }, o.accountId);
    const lost = coinForEncounter(1, BAND);
    const x = await byCausation(transferCausationId(`encounter:${tripId}:2`));
    expect(x.map((e) => [e.event_type, e.payload["amount"], e.payload["overflowDiscarded"]])).toEqual([
      ["coin_transferred_to_party_owner", 0, lost],
      ["coin_earned", 0, TUNABLES.COIN_PER_PARTY_WIN],
    ]);
    expect(await balance(o.accountId)).toBe(TUNABLES.COIN_STORAGE_CAP);
    const [l] = await eventsOf(d.accountId, "coin_lost_on_wipe");
    expect(l!.payload).toMatchObject({ amount: lost, transferred: 0, destroyed: lost, destroyedReason: "recipient_storage_cap" });

    // S2: the owner's feed says what the cap swallowed.
    const feed = await call(o, "GET", "/me/party/feed");
    expect(feed.statusCode).toBe(200);
    const entry = feed.json().entries.find((e: { jobId: string }) => e.jobId === `encounter:${tripId}:2`);
    expect(entry).toMatchObject({ coinEarned: 0, coinTransferred: 0, partyWinCoin: 0, coinDiscardedAtCap: lost + TUNABLES.COIN_PER_PARTY_WIN });
    // S1: the feed names the defender by username only.
    expect(Object.keys(entry.defender).sort()).toEqual(["caravanId", "caravanName", "regionId", "username"]);
    expect(feed.body).not.toContain(d.accountId);

    // S1: the defender's ledger read model drops the party owner's account id everywhere.
    const led = await call(d, "GET", "/me/ledger?limit=500");
    expect(led.statusCode).toBe(200);
    const events = led.json().events as { type: string; accountId: string; payload: Record<string, unknown> }[];
    const overrun = events.find((e) => e.type === "trip_overrun")!;
    expect(overrun.payload).not.toHaveProperty("partyOwnerAccountId");
    expect(overrun.payload).toMatchObject({ tripId, partyOwnerAuthored: false, lossesApplied: true });
    expect(events.every((e) => e.accountId === d.accountId)).toBe(true); // the reader's own id stays
    expect(led.body).not.toContain(o.accountId);
    // …while the ledger row itself (the auditable record) is untouched.
    expect((await eventsOf(d.accountId, "trip_overrun"))[0]!.payload["partyOwnerAccountId"]).toBe(o.accountId);
    // The owner's ledger: party_served_as_encounter without the defender's account id.
    const oled = await call(o, "GET", "/me/ledger?limit=500");
    const served = (oled.json().events as { type: string; payload: Record<string, unknown> }[]).filter((e) => e.type === "party_served_as_encounter");
    expect(served.length).toBeGreaterThan(0);
    for (const e of served) expect(e.payload).not.toHaveProperty("defenderAccountId");
    expect(oled.body).not.toContain(d.accountId);
  });

  it("redactForeignAccountIds drops foreign ids at any depth and keeps the reader's own", () => {
    const own = "11111111-1111-1111-1111-111111111111";
    const other = "22222222-2222-2222-2222-222222222222";
    expect(redactForeignAccountIds({ a: 1, partyOwnerAccountId: other, accountId: own, party: { ownerAccountId: other, units: [{ defenderAccountId: other, x: 2 }] } }, own)).toEqual({
      a: 1,
      accountId: own,
      party: { units: [{ x: 2 }] },
    });
  });
});

describe("QA N3: the bank clamps against the balance its forecast showed (the pending trickle is flushed first)", () => {
  it("with 10 h of trickle pending and the store nearly full, the bank credits exactly the forecast's wouldCredit", async () => {
    const d = await makeDefender();
    await setBalance(d.accountId, TUNABLES.COIN_STORAGE_CAP - 3_000);
    await pack(d);
    const tripId = await start(d);
    await encounter(d, 1, { kind: "caravan_held" });
    const later = Date.now() + 10 * 3_600_000; // + 2,000 coins of trickle, not yet written
    const row = await caravanRow(d);
    const p = await stakesPreview(appRole, row, later);
    // ~2,000 coins pending (a few more if the test ran slowly): the room is ~1,000, below the bank's total.
    expect(p.bankNow!.forecast.balance).toBeGreaterThanOrEqual(TUNABLES.COIN_STORAGE_CAP - 1_000);
    expect(p.bankNow!.forecast.wouldCredit).toBe(TUNABLES.COIN_STORAGE_CAP - p.bankNow!.forecast.balance);
    expect(p.bankNow!.forecast.wouldCredit).toBeLessThan(p.bankNow!.total); // without the flush the bank would credit the full total
    expect(p.bankNow!.forecast.wouldDiscard).toBe(p.bankNow!.total - p.bankNow!.forecast.wouldCredit);
    const res = await withTransaction(appRole, (c) => bankTrip(c, row, { tripId, encounterIndex: 1 }, later));
    expect(res.credited).toBe(p.bankNow!.forecast.wouldCredit);
    expect(res.discarded).toBe(p.bankNow!.forecast.wouldDiscard);
    expect(await balance(d.accountId)).toBe(TUNABLES.COIN_STORAGE_CAP);
  });

  it("QA N2: the preview reads one REPEATABLE READ snapshot and indexes deaths with the losses' own deathIndex", () => {
    const svc = readFileSync(join(SRC, "trip/service.ts"), "utf8");
    const fn = svc.slice(svc.indexOf("export async function stakesPreview"), svc.indexOf("export { findTripById }"));
    expect(fn).toMatch(/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
    expect(fn).toMatch(/const diedAt = deathIndex\(rows\)/);
    expect(fn).not.toMatch(/diedAt\.set\(/);
  });
});

// The reviewer's randomized probe (scratchpad/qa19/probe.test.ts), scaled to 6 histories.
async function packUnits(d: Player, units: string[]): Promise<void> {
  const res = await call(d, "POST", `/caravans/${d.caravanId}/manifest`, { units, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 2 } });
  expect(res.statusCode, res.body).toBe(201);
}
async function encounterAll(d: Player, n: number, plan: (posted: string[]) => EncounterPlan, ownerId?: string): Promise<void> {
  await searchAndChoose(d, n, ownerId);
  const m = await survivors(d);
  const alive = m.units.filter((u) => u.hp > 0).map((u) => u.ref);
  const f = await call(d, "PUT", `/caravans/${d.caravanId}/encounters/${n}/formation`, arrangement(m));
  expect(f.statusCode, f.body).toBe(200);
  const c = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/${n}/commit`);
  expect([200, 202], c.body).toContain(c.statusCode);
  await worker(doubleHandlers({ [n]: plan(alive) }));
  expect((await call(d, "GET", `/me/caravans/${d.caravanId}/trip`)).statusCode).toBe(200);
}
async function ownerSnapshot(o: Player): Promise<string> {
  const units = await roster(o.caravanId);
  const party = (await pool.query("SELECT * FROM standing_party WHERE account_id = $1", [o.accountId])).rows;
  const view = (await call(o, "GET", "/me/party")).body;
  return JSON.stringify({ units, party, view });
}

describe("QA probe, randomized: preview == applied, Coin conserved (transfer + destroyed == lost; party win on top), owners untouched", () => {
  it("6 seeded random trip histories, banked or overrun", async () => {
    let seed = 19;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let t = 0; t < 6; t++) {
      const { owners } = await makeIsland();
      const recipient = owners[t % 3]!;
      const d = await registerPlayer("desert");
      const units: string[] = [];
      for (let i = 0, n = 1 + Math.floor(rnd() * 6); i < n; i++) units.push(...(await giveUnits(d, 1, rnd() < 0.5 ? "desert.dust_rider" : "desert.well_digger", 1 + Math.floor(rnd() * 5))));
      const town = await giveUnits(d, 1, "desert.dust_rider", 3);
      await setLiving(d, GENERAL_RATING);
      if (rnd() < 0.4) await setBalance(recipient.accountId, TUNABLES.COIN_STORAGE_CAP - Math.floor(rnd() * 1_500));
      const ownerBefore = await Promise.all(owners.map(ownerSnapshot));
      const townBefore = JSON.stringify((await roster(d.caravanId)).filter((r) => town.includes(r.id)));
      const balBefore = await balance(d.accountId);
      await packUnits(d, units);
      const tripId = await start(d);
      const k = 1 + Math.floor(rnd() * 3);
      const ends = rnd() < 0.5 ? "bank" : "overrun";
      let p: StakesPreview | null = null;
      for (let e = 1; e <= k; e++) {
        await encounterAll(d, e, (posted) => ({ kind: rnd() < 0.3 ? "stalemate" : "caravan_held", kill: posted.filter(() => rnd() < 0.3), unitDamage: Math.floor(rnd() * 3) }));
        p = await preview(d);
        if (e < k || ends === "overrun") await push(d, tripId, e);
      }
      if (ends === "bank") {
        const r = await bank(d, tripId, k);
        expect(r.statusCode, r.body).toBe(200);
        const b = r.json();
        expect(b.restored.deMerged).toEqual(p!.bankNow!.unitsDeMerged);
        expect(b.requested).toBe(p!.bankNow!.total);
        expect(b.credited).toBe(p!.bankNow!.forecast.wouldCredit);
        for (const u of p!.bankNow!.unitsDeMerged) expect(await levelOf(u.ref)).toBe(u.toLevel);
        expect(await balance(d.accountId)).toBe(balBefore + b.credited);
      } else {
        const recBefore = await balance(recipient.accountId);
        let finalKilled: string[] = [];
        await encounterAll(d, k + 1, (ps) => {
          finalKilled = ps.filter(() => rnd() < 0.4);
          return { kind: "caravan_overrun", kill: finalKilled };
        }, recipient.accountId);
        const h = (await byCausation(`trip:${tripId}:overrun`))[0]!.payload as unknown as { losses: { destroyed: { ref: string }[]; deMerged: { ref: string; fromLevel: number }[]; coin: { lost: number; transferred: number; destroyed: number; partyWin: { amount: number; credited: number; discarded: number } } } };
        const expectDestroyed = p!.ifOverrun.unitsLostOutright.filter((u) => !finalKilled.includes(u.ref));
        expect(h.losses.destroyed.map((u) => u.ref)).toEqual(expectDestroyed.map((u) => u.ref));
        expect(h.losses.deMerged.map((u) => u.ref).sort()).toEqual([...p!.ifOverrun.unitsDeMergedNotDestroyed.map((u) => u.ref), ...finalKilled].sort());
        expect(h.losses.coin.lost).toBe(p!.ifOverrun.coinLost);
        expect(h.losses.coin.transferred + h.losses.coin.destroyed).toBe(h.losses.coin.lost);
        expect(h.losses.coin.partyWin.amount).toBe(TUNABLES.COIN_PER_PARTY_WIN);
        expect(h.losses.coin.partyWin.credited + h.losses.coin.partyWin.discarded).toBe(TUNABLES.COIN_PER_PARTY_WIN);
        expect(await balance(recipient.accountId)).toBe(recBefore + h.losses.coin.transferred + h.losses.coin.partyWin.credited);
        expect(await balance(recipient.accountId)).toBeLessThanOrEqual(TUNABLES.COIN_STORAGE_CAP);
        expect(await balance(d.accountId)).toBe(balBefore);
        for (const u of expectDestroyed) expect(await levelOf(u.ref)).toBeNull();
        for (const u of h.losses.deMerged) expect(await levelOf(u.ref)).toBe(Math.max(1, u.fromLevel - 1));
        const dm = new Set(h.losses.deMerged.map((u) => u.ref));
        expect(h.losses.destroyed.some((u) => dm.has(u.ref))).toBe(false);
      }
      expect(JSON.stringify((await roster(d.caravanId)).filter((r) => town.includes(r.id)))).toBe(townBefore);
      expect(await Promise.all(owners.map(ownerSnapshot))).toEqual(ownerBefore);
      const dms = (await eventsOf(d.accountId, "unit_demerged_on_death")).map((e) => e.payload["unitInstanceId"]);
      expect(new Set(dms).size).toBe(dms.length);
    }
  }, 300_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Last: seeds the authored set (it would crowd the islands above).
describe("system (authored) owners: Coin lost to them is destroyed, nothing is minted, the floor applies", () => {
  it("held vs an out-of-band authored party: earn floored by the chosen multiplier; overrun by one: all destroyed, zero events on the system account but the feed entry", async () => {
    await seedAuthoredParties(appRole);
    const d = await makeDefender();
    const FAR = 9_000; // beyond every island above and every authored band: the authored outside-band fallback
    await setLiving(d, FAR);
    await pack(d);
    const tripId = await start(d);
    const pickAuthored = async (n: number): Promise<string> => {
      await setLiving(d, FAR);
      const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/search`);
      expect(s.statusCode, s.body).toBe(201);
      const c = (s.json().menu.candidates as { candidateId: string; owner: { authored: boolean } }[]).find((x) => x.owner.authored)!;
      expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/choose`, { candidateId: c.candidateId })).statusCode).toBe(200);
      const chosen = await chosenCandidate(pool, tripId, n);
      return chosen!.owner.accountId;
    };
    const sys1 = await pickAuthored(1);
    await arrangeAndCommit(d, 1);
    await worker(doubleHandlers({ 1: { kind: "caravan_held" } }));
    await call(d, "GET", `/me/caravans/${d.caravanId}/trip`);
    const m = (await chosenCandidate(pool, tripId, 1))!.reputation.sandbagEarnMultiplier;
    expect(m).toBeLessThan(FIXED_ONE);
    const accrued1 = (await pool.query("SELECT coin_accrued FROM trip_encounter WHERE trip_id = $1 AND encounter_index = 1", [tripId])).rows[0].coin_accrued;
    expect(accrued1).toBe(applyEarnFloor(coinForEncounter(1, bandOf(FAR).index), m));
    const p = await preview(d);
    expect(p.unbankedCoin.total).toBe(accrued1);
    expect(p.ifOverrun.coinLost).toBe(accrued1);
    await push(d, tripId, 1);

    const sys2 = await pickAuthored(2);
    const sysEvents0 = await eventsOf(sys2);
    const sysPerm0 = await permanence(sys2, null);
    const sysCoin0 = (await pool.query("SELECT coin_balance FROM account WHERE id = $1", [sys2])).rows[0].coin_balance;
    await arrangeAndCommit(d, 2);
    await worker(doubleHandlers({ 2: { kind: "caravan_overrun" } }));
    await call(d, "GET", `/me/caravans/${d.caravanId}/trip`);
    expect((await eventsOf(sys2)).slice(sysEvents0.length).map((e) => e.event_type)).toEqual(["party_served_as_encounter"]);
    expect(await permanence(sys2, null)).toEqual(sysPerm0);
    expect((await pool.query("SELECT coin_balance FROM account WHERE id = $1", [sys2])).rows[0].coin_balance).toBe(sysCoin0);
    expect((await byCausation(transferCausationId(`encounter:${tripId}:2`))).length).toBe(0);
    const [lost] = await eventsOf(d.accountId, "coin_lost_on_wipe");
    expect(lost!.payload).toMatchObject({ amount: accrued1, transferred: 0, destroyed: accrued1, destroyedReason: "system_owner", recipientAuthored: true });
    // The caravan's own side resolved in full: its losses applied, its Reputation moved.
    expect((await eventsOf(d.accountId, "unit_lost_on_wipe")).length).toBe(3);
    expect((await eventsOf(d.accountId, "reputation_changed")).length).toBe(2);
    expect(sys1).toBeTruthy();
    expect((await getJob(pool, `encounter:${tripId}:2`))!.status).toBe("completed");
  });

  it("chunk 15 QA S1: a bank credits the STORED floored per-encounter Coin, never the live schedule; the preview total equals it", async () => {
    const d = await makeDefender();
    await setLiving(d, 9_000);
    await pack(d);
    const tripId = await start(d);
    const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
    const c = (s.json().menu.candidates as { candidateId: string; owner: { authored: boolean } }[]).find((x) => x.owner.authored)!;
    expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: c.candidateId })).statusCode).toBe(200);
    await arrangeAndCommit(d, 1);
    await worker(doubleHandlers({ 1: { kind: "caravan_held" } }));
    const p = await preview(d);
    const accrued = (await pool.query("SELECT coin_accrued FROM trip_encounter WHERE trip_id = $1", [tripId])).rows[0].coin_accrued as number;
    expect(accrued).toBeLessThan(coinForEncounter(1, bandOf(9_000).index));
    const res = await bank(d, tripId, 1);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().requested).toBe(p.bankNow!.total);
    const earned = (await eventsOf(d.accountId, "coin_earned")).filter((e) => e.payload["tripId"] === tripId);
    expect(earned.map((e) => [e.payload["reason"], e.payload["amount"]])).toEqual([
      ["encounter_survived", accrued],
      ["trip_banked", TUNABLES.COIN_DELIVERY_PER_ENCOUNTER],
    ]);
    // The bank path never recomputes Coin from the schedule.
    const svc = readFileSync(join(SRC, "trip/service.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(svc).not.toMatch(/coinForEncountersSurvived|coinForBankedTrip/);
  });
});
