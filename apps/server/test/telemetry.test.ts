/**
 * Chunk 32 — telemetry and balance instrumentation (PHASE-2 §32).
 *
 * One seeded history, written through the real routes and writers on the server's own DB role
 * (trips resolved by the deterministic double, a merge-shaped spend, a refugee reroll, a pack
 * purchase, unlock and ladder events, client screen flow), then every dashboard panel is
 * checked against the exact numbers that history implies — or, for Coin, against an
 * independent fold of the same ledger rows. Then:
 *   - /admin/* answers 404 to no token, a bad token and a non-admin; the app role cannot grant
 *     admin (no INSERT/UPDATE/DELETE on account_admin), and no player route writes it;
 *   - opt-out: stored server-side, honoured at ingest (nothing kept), deletes what was kept,
 *     and drops the account from the return cohort;
 *   - ingest limits: body cap (413), batch cap, closed vocabularies, rate limit (429), daily cap;
 *   - privacy: rows carry the opaque analytics id, never the account id, and cascade away
 *     with the account;
 *   - analytics never feed back: nothing outside src/analytics and its routes reads them.
 */
import { RING_ANCHORS, entryBand, type PartyConfig } from "@caravan/circle";
import { TUNABLES, UNLOCK_WEBS, weekIndexAt } from "@caravan/content";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { grantAdmin, revokeAdmin } from "../src/analytics/admin.js";
import { TelemetryRateLimiter, ingest, saveSettings } from "../src/analytics/clientEvents.js";
import { PANEL_IDS, PANEL_SUBSYSTEMS, TUNING_MAP, buildDashboard, type Dashboard } from "../src/analytics/dashboard.js";
import { THIN_BAND_PARTIES, UNIT_AFFINITY } from "../src/analytics/queries.js";
import { ADMIN_REQUESTS_PER_MINUTE, TELEMETRY_DAILY_EVENT_CAP, TELEMETRY_FLUSH_WINDOW_MS, TELEMETRY_SCREENS } from "../src/analytics/tunables.js";
import { seedAuthoredParties } from "../src/matchmaking/authored.js";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import { doubleHandlers, type EncounterPlan } from "../src/dev/tripDouble.js";
import { appendCoinCredits } from "../src/economy/coin.js";
import { drain } from "../src/jobs/worker.js";
import { appendEvents } from "../src/ledger/ledger.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique, seasonCaravan, servedNameOf } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  username: string;
  accountId: string;
  caravanId: string;
}

async function register(prefix: string): Promise<Player> {
  const username = unique(prefix);
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username, password: "correct horse battery", region: "desert" } });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json();
  await seasonCaravan(pool, b.caravan.id); // r2 S2: the trips a test starts are not the caravan's first
  return { token: b.token, username, accountId: b.account.id, caravanId: b.caravan.id };
}

function call(p: Player | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { ...(p ? { authorization: `Bearer ${p.token}` } : {}), ...headers } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

async function giveUnits(p: Player, typeIds: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const unitTypeId of typeIds) ids.push((await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId, mergeLevel: 1 })).id);
  return ids;
}

const EDGES = ["north", "east", "south", "west"] as const;
function partyOf(units: readonly string[]): PartyConfig {
  return { v: 1, units: units.map((ref, i) => ({ ref, stance: "nearest" as const, edge: EDGES[i % 4]!, cell: entryBand(EDGES[i % 4]!)[3 + i]! })), siege: ["siege.battering_wagon"] };
}

/** One encounter: search, choose a main owner's party (same composition either way), arrange 2 guard posts + 1 trap + 1 fence, commit, resolve with `plan`, settle. */
async function encounter(d: Player, posts: string[], n: number, plan: EncounterPlan): Promise<void> {
  const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/search`);
  expect(s.statusCode, s.body).toBe(201);
  // The menu is a seeded draw of 3 from 4; at least one of the two same-composition owners is in it.
  const mains = [await servedNameOf(pool, owner.username), await servedNameOf(pool, owner2.username)]; // r2 N16
  const cand = (s.json().menu.candidates as { candidateId: string; owner: { displayName: string } }[]).find((c) => mains.includes(c.owner.displayName));
  expect(cand, "a main owner's party is in the menu").toBeDefined();
  expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/${n}/choose`, { candidateId: cand!.candidateId })).statusCode).toBe(200);
  const c = RING_ANCHORS[0]!;
  const formation = {
    v: 2,
    fences: n === 1 ? [{ ref: "f0", segment: 0 }] : [],
    traps: n === 1 ? [{ ref: "t0", cell: { x: c.x + 1, y: c.y + 1 } }] : [],
    posts: posts.map((ref, i) => ({ ref, cell: { x: c.x + 2 + i, y: c.y + 2 }, stance: "guard" })),
  };
  const f = await call(d, "PUT", `/caravans/${d.caravanId}/encounters/${n}/formation`, formation);
  expect(f.statusCode, f.body).toBe(200);
  const commit = await call(d, "POST", `/me/caravans/${d.caravanId}/trip/encounters/${n}/commit`);
  expect(commit.statusCode, commit.body).toBe(202);
  await drain(appRole, { workerId: "telemetry-test", handlers: doubleHandlers({ [n]: plan }), retryBackoffMs: () => 0 });
  expect((await call(d, "GET", `/me/caravans/${d.caravanId}/trip`)).statusCode).toBe(200); // settles
}

async function defender(): Promise<{ p: Player; posts: string[]; tripId: string }> {
  const p = await register("def");
  const posts = await giveUnits(p, ["desert.dust_rider", "desert.dust_rider"]);
  const m = await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units: posts, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 4 } });
  expect(m.statusCode, m.body).toBe(201);
  const start = await call(p, "POST", `/me/caravans/${p.caravanId}/trip/start`);
  expect(start.statusCode, start.body).toBe(201);
  return { p, posts, tripId: start.json().tripId };
}

/** Per-player batch sequence (QA D2: a batch carries the page session and its sequence number). */
const seqs = new Map<string, number>();
async function telemetry(p: Player, events: unknown[], session = 1): Promise<LightMyRequestResponse> {
  const seq = seqs.get(p.accountId) ?? 0;
  seqs.set(p.accountId, seq + 1);
  return call(p, "POST", "/me/telemetry", { session, seq, events });
}

/** Send one batch with the server's clock at `atMs` (session times are receipt times, QA D2). */
async function telemetryAt(p: Player, atMs: number, events: unknown[]): Promise<LightMyRequestResponse> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(atMs);
  try {
    return await telemetry(p, events);
  } finally {
    vi.useRealTimers();
  }
}

let owner: Player;
let owner2: Player;
let defenders: Player[];
let shopper: Player;
let optedOutBuyer: Player;
let admin: Player;
let mergedIds: string[];
let unlockedNode: { id: string; cost: number };
let dash: Dashboard;
let nowMs: number;

async function dashboard(p: Player = admin, query = `?week=${weekIndexAt(Date.now())}`): Promise<Dashboard> {
  const res = await call(p, "GET", `/admin/dashboard${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

beforeAll(async () => {
  await truncateAll(pool);
  appRole = appRolePool();
  app = await buildApp({ db: appRole });

  owner = await register("own");
  const res = await call(owner, "PUT", "/me/party", partyOf(await giveUnits(owner, ["desert.dust_rider", "desert.well_digger"])));
  expect(res.statusCode, res.body).toBe(200);
  // The same composition under a second owner: a caravan never meets the same party twice in a
  // row (RECENT_OPPONENT_EXCLUSION), so encounter 2 is fought against this one.
  owner2 = await register("own");
  expect((await call(owner2, "PUT", "/me/party", partyOf(await giveUnits(owner2, ["desert.dust_rider", "desert.well_digger"])))).statusCode).toBe(200);
  // A full menu needs CANDIDATES_PER_SEARCH servable parties: two more owners, one rider each, no siege.
  for (let i = 0; i < 2; i++) {
    const o = await register("own");
    const ids = await giveUnits(o, ["desert.dust_rider"]);
    expect((await call(o, "PUT", "/me/party", { ...partyOf(ids), siege: [] })).statusCode).toBe(200);
  }

  // Three trips: held → bank at 1; held → push → overrun at 2; stalemate → bank at 1.
  const a = await defender();
  await encounter(a.p, a.posts, 1, { kind: "caravan_held", fenceDamage: 1000 });
  expect((await call(a.p, "POST", `/me/caravans/${a.p.caravanId}/trip/bank`, { tripId: a.tripId, encounterIndex: 1 })).statusCode).toBe(200);
  const b = await defender();
  await encounter(b.p, b.posts, 1, { kind: "caravan_held" });
  expect((await call(b.p, "POST", `/me/caravans/${b.p.caravanId}/trip/push`, { tripId: b.tripId, encounterIndex: 1 })).statusCode).toBe(200);
  await encounter(b.p, b.posts, 2, { kind: "caravan_overrun" });
  const c = await defender();
  await encounter(c.p, c.posts, 1, { kind: "stalemate", fenceDamage: 50 });
  expect((await call(c.p, "POST", `/me/caravans/${c.p.caravanId}/trip/bank`, { tripId: c.tripId, encounterIndex: 1 })).statusCode).toBe(200);
  defenders = [a.p, b.p, c.p];

  // Spending: a refugee reroll (the GET bootstraps the free menu), a merge-shaped spend, a pack purchase.
  shopper = await register("shop");
  await withTransaction(pool, (cl) => appendCoinCredits(cl, { causationId: `test:tlm:credit:${shopper.accountId}`, accountId: shopper.accountId, credits: [{ amount: 5000, reason: "test_setup" }] }));
  const view = await call(shopper, "GET", `/me/caravans/${shopper.caravanId}/refugees`);
  expect(view.statusCode, view.body).toBe(200);
  const reroll = await call(shopper, "POST", `/me/caravans/${shopper.caravanId}/refugees/reroll`, { fromSequence: view.json().menu.sequence });
  expect(reroll.statusCode, reroll.body).toBe(201);
  // QA N9: a real merge through the route (two L1 riders → one L2), not a hand-written payload.
  mergedIds = await giveUnits(shopper, ["desert.dust_rider", "desert.dust_rider"]);
  const merged = await call(shopper, "POST", `/me/caravans/${shopper.caravanId}/merge`, { instanceIds: mergedIds });
  expect(merged.statusCode, merged.body).toBe(200);
  const store = (await call(shopper, "GET", "/me/store")).json();
  const buy = await call(shopper, "POST", "/me/store/purchase", { tier: 1, weekIndex: store.week.index, contentsHash: store.offers[0].contentsHash });
  expect(buy.statusCode, buy.body).toBe(201);
  // Ladder and unlock web, trap pool (account-level). QA N9: the purchase goes through the spend
  // route, on the first reachable trap node, with points granted for exactly its cost.
  const webs = (await call(shopper, "GET", "/me/unlocks")).json().webs as { pool: string; nodes: { id: string; cost: number; reached: boolean; prerequisitesMet: boolean }[] }[];
  const target = webs.find((w) => w.pool === "trap")!.nodes.find((n) => !n.reached && n.prerequisitesMet && n.cost > 0)!;
  unlockedNode = { id: target.id, cost: target.cost };
  await withTransaction(pool, (cl) =>
    appendEvents(cl, `test:tlm:unlock:${shopper.accountId}`, [
      { type: "ladder_progress_gained", accountId: shopper.accountId, payload: { pool: "trap", pointsDelta: 40, levelsGained: 1 } },
      { type: "unlock_points_granted", accountId: shopper.accountId, payload: { pool: "trap", points: target.cost, rung: 1 } },
    ]),
  );
  const spend = await call(shopper, "POST", "/me/unlocks/spend", { pool: "trap", nodeId: target.id });
  expect(spend.statusCode, spend.body).toBe(201);

  // Screen flow, timed by the SERVER's clock (QA D2): two sessions (10 min, then a 39 min gap, then
  // 1 min — a heartbeat in it) and one crash, from the shopper.
  const base = Date.now();
  const flow: [number, unknown][] = [
    [base - 3_000_000, { kind: "screen", screen: "town" }],
    [base - 2_700_000, { kind: "screen", screen: "packs" }],
    [base - 2_400_000, { kind: "screen", screen: "town" }],
    [base - 60_000, { kind: "screen", screen: "trail" }],
    [base - 30_000, { kind: "crash", screen: "trail", errorName: "TypeError", stackHash: "0badc0de" }],
    [base - 20_000, { kind: "heartbeat", screen: "trail" }],
    [base, { kind: "screen", screen: "town" }],
  ];
  for (const [at, ev] of flow) {
    const sent = await telemetryAt(shopper, at, [ev]);
    expect(sent.statusCode, sent.body).toBe(202);
    expect(sent.json()).toEqual({ accepted: 1, dropped: 0, optedOut: false });
  }

  // QA D4: a buyer who has opted out of usage data — outside the funnel's population.
  optedOutBuyer = await register("oob");
  const store2 = (await call(optedOutBuyer, "GET", "/me/store")).json();
  expect((await call(optedOutBuyer, "POST", "/me/store/purchase", { tier: 2, weekIndex: store2.week.index, contentsHash: store2.offers[1].contentsHash })).statusCode).toBe(201);
  expect((await call(optedOutBuyer, "PUT", "/me/analytics", { optedOut: true })).statusCode).toBe(200);

  // QA S1: the cold-start outfits, seeded through the real writers (ladders, unlock purchases,
  // rosters) AFTER the trips (so every menu above stayed the four live parties). No panel may count them.
  await seedAuthoredParties(appRole);

  admin = await register("adm");
  // (players: 4 owners, 3 defenders, the shopper, the opted-out buyer, the admin)
  await grantAdmin(pool, admin.username, "telemetry-test");
  nowMs = Date.now();
  dash = await dashboard();
}, 120_000);

afterAll(async () => {
  await truncateAll(pool);
  await app.close();
  await appRole.end();
  await pool.end();
});

describe("chunk 32: every panel against the seeded history", () => {
  it("trip length: two trips banked after 1 encounter, one overrun at encounter 2", () => {
    expect(dash.panels.tripLength).toEqual([
      { endReason: "banked", encounters: 1, trips: 2 },
      { endReason: "overrun", encounters: 2, trips: 1 },
    ]);
  });

  it("bank versus push by encounter index", () => {
    expect(dash.panels.bankVsPush).toEqual([
      { encounterIndex: 1, settled: 3, held: 2, overrun: 0, stalemate: 1, pushed: 1, banked: 2, undecided: 0, pushRateBp: 3333, overrunRateBp: 0 },
      { encounterIndex: 2, settled: 1, held: 0, overrun: 1, stalemate: 0, pushed: 0, banked: 0, undecided: 0, pushRateBp: null, overrunRateBp: 10_000 },
    ]);
  });

  it("overrun rate by the caravan's Reputation band (every caravan starts at REPUTATION_START, 400 since the chunk 37 balance pass: band 1)", () => {
    expect(dash.panels.overrunByBand).toEqual([{ band: 1, encounters: 4, held: 2, overrun: 1, stalemate: 1, overrunRateBp: 2500 }]);
  });

  it("unit pick and win rates on both sides; trap and siege usage; stances and slot fill", () => {
    expect(dash.panels.defenderUnits).toEqual({ settled: 4, rows: [{ typeId: "desert.dust_rider", appearances: 4, wins: 2, pickRateBp: 10_000, winRateBp: 5000 }] });
    expect(dash.panels.attackerUnits).toEqual({
      settled: 4,
      rows: [
        { typeId: "desert.dust_rider", appearances: 4, wins: 1, pickRateBp: 10_000, winRateBp: 2500, live: 4 },
        { typeId: "desert.well_digger", appearances: 4, wins: 1, pickRateBp: 10_000, winRateBp: 2500, live: 4 },
      ],
    });
    expect(dash.panels.traps).toEqual({ settled: 4, rows: [{ typeId: "trap.spike_pit", appearances: 3, wins: 2, pickRateBp: 7500, winRateBp: 6666 }] });
    expect(dash.panels.siege).toEqual({ settled: 4, rows: [{ typeId: "siege.battering_wagon", appearances: 4, wins: 1, pickRateBp: 10_000, winRateBp: 2500 }] });
    expect(dash.panels.stances).toEqual([{ stance: "guard", posts: 8, held: 4, heldRateBp: 5000 }]);
    expect(dash.panels.slots).toEqual([
      { side: "fences", count: 0, encounters: 1, held: 0, heldRateBp: 0 },
      { side: "fences", count: 1, encounters: 3, held: 2, heldRateBp: 6666 },
      { side: "posted", count: 2, encounters: 4, held: 2, heldRateBp: 5000 },
      { side: "raiders", count: 2, encounters: 4, held: 2, heldRateBp: 5000 },
      { side: "traps", count: 0, encounters: 1, held: 0, heldRateBp: 0 },
      { side: "traps", count: 1, encounters: 3, held: 2, heldRateBp: 6666 },
    ]);
  });

  it("QA D3: held rate by affinity matchup and by merge level, and fence breakage by tier", () => {
    const d = UNIT_AFFINITY["desert.dust_rider"]!;
    const raiders = [...new Set([UNIT_AFFINITY["desert.dust_rider"]!, UNIT_AFFINITY["desert.well_digger"]!])].sort();
    expect(dash.panels.matchups).toEqual(raiders.map((a) => ({ defender: d, attacker: a, encounters: 4, held: 2, overrun: 1, heldRateBp: 5000 })));
    expect(dash.panels.mergeLevels).toEqual([
      { side: "posted", level: 1, encounters: 4, held: 2, heldRateBp: 5000 },
      { side: "raiders", level: 1, encounters: 4, held: 2, heldRateBp: 5000 },
    ]);
    // Three encounter-1 circles placed one brush pile (300 HP) each: one broken outright, one lost 50 HP.
    expect(dash.panels.fences).toEqual([{ tierId: "fence.brush_pile", placed: 3, broken: 1, damaged: 2, hpLost: 350, brokenRateBp: 3333 }]);
  });

  it("tick cap: the double's stalemate ends at tick 3599 (the last tick simulated) — it is the fight the cap ended (QA D1)", () => {
    expect(dash.panels.tickCap).toEqual({
      capTicks: 3600,
      nearCapTicks: 3240,
      rows: [
        { outcomeKind: "caravan_held", fights: 2, nearCap: 0, atCap: 0, maxEndTick: 600, medianEndTick: 600 },
        { outcomeKind: "caravan_overrun", fights: 1, nearCap: 0, atCap: 0, maxEndTick: 600, medianEndTick: 600 },
        { outcomeKind: "stalemate", fights: 1, nearCap: 1, atCap: 1, maxEndTick: 3599, medianEndTick: 3599 },
      ],
    });
  });

  it("trip cap: three starts by three accounts, none took the last use", () => {
    expect(dash.panels.tripCap).toEqual({ starts: 3, accounts: 3, tookLastUse: 0, tookLastUseBp: 0, capPerHour: TUNABLES.TRIPS_PER_HOUR_CAP });
  });

  it("merge spend over time, spend by reason (merge, the reroll), refugee menus per day", () => {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    // One real merge (route): two L1 riders into one L2 at MERGE_COST_BY_TARGET_LEVEL[2].
    const cost = TUNABLES.MERGE_COST_BY_TARGET_LEVEL[2]!;
    expect(dash.panels.mergeSpend).toEqual({ byDay: [{ day: today, merges: 1, coin: cost }], byLevel: [{ toLevel: 2, merges: 1, coin: cost }] });
    expect(dash.panels.spendByReason).toEqual([
      { reason: "merge", events: 1, coin: cost },
      { reason: "refugee_reroll", events: 1, coin: TUNABLES.REFUGEE_REROLL_COST_SCHEDULE[0] },
    ]);
    // Every registered caravan's GET of the trip did not touch the drip; only the shopper opened it.
    expect(dash.panels.refugees).toEqual([{ day: today, freeMenus: 1, rerolls: 1, claims: 0, caravans: 1 }]);
  });

  it("Coin by source equals an independent fold of the ledger's credit rows", async () => {
    const rows = (await pool.query<{ event_type: string; payload: Record<string, unknown> }>("SELECT e.event_type::text, e.payload FROM ledger_event e JOIN account a ON a.id = e.account_id WHERE NOT a.is_system AND e.event_type IN ('coin_earned','coin_transferred_to_party_owner','coin_purchased')")).rows;
    const fold = new Map<string, { type: string; reason: string; events: number; coin: number; discarded: number }>();
    for (const r of rows) {
      const k = `${r.event_type}|${String(r.payload["reason"])}`;
      const e = fold.get(k) ?? { type: r.event_type, reason: String(r.payload["reason"]), events: 0, coin: 0, discarded: 0 };
      e.events++;
      e.coin += Number(r.payload["amount"]);
      e.discarded += Number(r.payload["overflowDiscarded"] ?? 0);
      fold.set(k, e);
    }
    const expected = [...fold.values()].sort((x, y) => (x.type + x.reason < y.type + y.reason ? -1 : 1));
    expect(dash.panels.earnBySource).toEqual(expected);
    const reasons = expected.map((e) => `${e.type}:${e.reason}`);
    expect(reasons).toEqual(expect.arrayContaining(["coin_earned:encounter_survived", "coin_earned:trip_banked", "coin_earned:party_win", "coin_purchased:pack_purchase", "coin_earned:test_setup"]));
    expect(dash.panels.storageCap.discarded).toBe(expected.reduce((s, e) => s + e.discarded, 0));
  });

  it("storage cap pressure: no player is near the cap", () => {
    const players = 4 + 3 + 1 + 1 + 1; // four owners, three defenders, shopper, opted-out buyer, admin
    expect(dash.panels.storageCap).toMatchObject({ accounts: players, nearCap: 0, atCap: 0, cap: TUNABLES.COIN_STORAGE_CAP, nearCapPercent: 90 });
  });

  it("grind-wall probe: one decile per active player (the three who started trips), free earn from their own credits, none paid", async () => {
    const free = async (accountId: string): Promise<number> =>
      Number((await pool.query<{ s: string }>("SELECT coalesce(sum((payload->>'amount')::bigint),0)::text AS s FROM ledger_event WHERE account_id = $1 AND event_type IN ('coin_earned','coin_transferred_to_party_owner')", [accountId])).rows[0]!.s);
    const earns = (await Promise.all(defenders.map((d) => free(d.accountId)))).sort((x, y) => x - y);
    const g = dash.panels.grindWall;
    expect(g.weekIndex).toBe(weekIndexAt(nowMs));
    expect(g.weeklyPayCeiling).toBe(TUNABLES.WEEKLY_PAY_CEILING);
    expect(g.deciles).toEqual(
      earns.map((e, i) => ({ decile: i + 1, players: 1, minFree: e, maxFree: e, avgFree: e, avgPaid: 0, payers: 0, ceilingToFreeBp: e === 0 ? null : Math.floor((TUNABLES.WEEKLY_PAY_CEILING * 10_000) / e) })),
    );
    // The overrun at encounter 2 lost encounter 1's unbanked Coin: that defender earned least.
    expect(earns[0]).toBe(0);
  });

  it("ladder and unlock web: one trap rung gained, one trap node bought — and none of the 96 authored outfits' seeding (QA S1)", async () => {
    // The cold-start seeding wrote ladder gains and unlock purchases for the system accounts:
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_event e JOIN account a ON a.id = e.account_id WHERE a.is_system AND e.event_type IN ('ladder_progress_gained','unlock_node_purchased')")).rows[0]!.n).toBeGreaterThan(100);
    const ladderRows = (await pool.query<{ pool: string; points_delta: number; levels_gained: number }>("SELECT e.payload->>'pool' AS pool, (e.payload->>'pointsDelta')::int AS points_delta, (e.payload->>'levelsGained')::int AS levels_gained FROM ledger_event e JOIN account a ON a.id = e.account_id WHERE NOT a.is_system AND e.event_type = 'ladder_progress_gained'")).rows;
    // QA N5: every node of every web is a row; only the one bought has purchases.
    const bought = dash.panels.unlockPurchases.filter((r) => r.purchases > 0);
    expect(bought).toEqual([{ pool: "trap", nodeId: unlockedNode.id, purchases: 1, points: unlockedNode.cost }]);
    const nodes = new Set(UNLOCK_WEBS.flatMap((w) => w.nodes.map((n) => `${w.pool}|${n.id}`)));
    expect(dash.panels.unlockPurchases).toHaveLength(nodes.size);
    // Play itself moves the ladders too: the panel equals a fold of the ledger's ladder rows.
    const fold = new Map<string, { pool: string; events: number; points: number; rungs: number }>();
    for (const r of ladderRows) {
      const e = fold.get(r.pool) ?? { pool: r.pool, events: 0, points: 0, rungs: 0 };
      e.events++;
      e.points += r.points_delta;
      e.rungs += r.levels_gained;
      fold.set(r.pool, e);
    }
    expect(dash.panels.ladder.gained).toEqual([...fold.values()].sort((x, y) => (x.pool < y.pool ? -1 : 1)));
    expect(fold.get("trap")!.rungs).toBe(1);
    const trapLevels = dash.panels.ladder.levels.filter((l) => l.pool === "trap");
    expect(trapLevels).toEqual(expect.arrayContaining([{ pool: "trap", level: 1, owners: 1 }]));
    expect(trapLevels.reduce((s, l) => s + l.owners, 0)).toBe(10);
  });

  it("pack purchase funnel: one population (QA D4) — the opted-out buyer counts only in allBuyers, outside the funnel", () => {
    expect(dash.panels.packFunnel).toEqual({ viewers: 1, storeViewers: 1, buyers: 1, allBuyers: 2, tiers: [{ tier: 1, reserved: 1, settled: 1, buyers: 1, cents: TUNABLES.PACK_TIER_PRICES_CENTS[0] }], storeMode: "sandbox", counted: true });
    expect(dash.panels.packFunnel.buyers).toBeLessThanOrEqual(dash.panels.packFunnel.storeViewers);
  });

  it("session length from the server's receipt times: a 10-minute session and a 1-minute one (a 39-minute gap splits them; a heartbeat counts, a crash does not)", () => {
    expect(dash.panels.sessionLength).toEqual({
      sessions: 2,
      players: 1,
      medianMs: 60_000,
      maxMs: 600_000,
      screens: 6,
      gapMs: 1_800_000,
      buckets: [
        { label: "<1m", sessions: 0 },
        { label: "1–5m", sessions: 1 },
        { label: "5–15m", sessions: 1 },
        { label: "15–30m", sessions: 0 },
        { label: "30–60m", sessions: 0 },
        { label: "≥60m", sessions: 0 },
      ],
    });
    expect(dash.panels.screens).toEqual([
      { screen: "town", views: 3, viewers: 1 },
      { screen: "packs", views: 1, viewers: 1 },
      { screen: "trail", views: 1, viewers: 1 },
    ]);
    expect(dash.panels.crashes).toEqual([{ errorName: "TypeError", stackHash: "0badc0de", screen: "trail", reports: 1, reporters: 1 }]);
  });

  it("pool health: 4 live parties and 12 authored per band 0–7, ten player caravans, served shares, and the alarm rule (QA N3/N4)", () => {
    const bands = dash.panels.poolHealth.bands;
    expect(bands.map((b) => b.band)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const b of bands) expect(b.authoredParties, `band ${b.band}`).toBe(12);
    expect(bands[1]).toMatchObject({ low: 400, high: 699 }); // REPUTATION_START's band since the chunk 37 balance pass (was band 3)
    expect(bands.reduce((s, b) => s + b.liveParties, 0)).toBe(4);
    expect(bands.reduce((s, b) => s + b.caravans, 0)).toBe(10);
    // Encounter 1 searches 150 below the caravan (band 0); encounter 2 searches above it (band 1).
    expect(bands[0]).toMatchObject({ served: 3, servedAuthored: 0, servedAuthoredShareBp: 0, matchmakerWindow: { served: 3, authored: 0, shareBp: 0 } });
    expect(bands[1]).toMatchObject({ served: 1, servedAuthored: 0, servedAuthoredShareBp: 0, matchmakerWindow: { served: 1, authored: 0, shareBp: 0 } });
    expect(THIN_BAND_PARTIES).toBe(TUNABLES.CANDIDATES_PER_SEARCH + 1 + TUNABLES.RECENT_OPPONENT_EXCLUSION);
    for (const b of bands) {
      const total = b.liveParties + b.authoredParties;
      const over = b.matchmakerWindow.shareBp !== null && b.matchmakerWindow.shareBp > TUNABLES.AUTHORED_PARTY_MAX_SHARE_BP;
      expect(b.alarm, `band ${b.band}`).toBe(total < 3 ? "empty" : total < THIN_BAND_PARTIES ? "thin" : b.liveParties === 0 ? "no_live" : over ? "authored_over_share" : "ok");
    }
    expect(bands.filter((b) => b.liveParties === 0).every((b) => b.alarm === "no_live")).toBe(true);
    expect(dash.panels.poolHealth.alarms).toBe(bands.filter((b) => b.alarm !== "ok").length);
  });

  it("retention: day-1/7/30 return over backdated accounts; an opted-out account is left out", async () => {
    const mk = async (daysAgo: number, activeOnDays: number[], optOut = false): Promise<void> => {
      const p = await register("ret");
      await pool.query("UPDATE account SET created_at = now() - make_interval(days => $2) WHERE id = $1", [p.accountId, daysAgo]);
      for (const d of activeOnDays) {
        await pool.query(
          `INSERT INTO ledger_event (event_type, account_id, causation_id, causation_seq, payload, occurred_at)
           SELECT 'coin_spent', id, $2, 0, '{"amount":0,"reason":"test_activity"}', created_at + make_interval(days => $3, hours => 1) FROM account WHERE id = $1`,
          [p.accountId, `test:ret:${p.accountId}:${d}`, d],
        );
      }
      if (optOut) expect((await call(p, "PUT", "/me/analytics", { optedOut: true })).statusCode).toBe(200);
    };
    await mk(10, [1]);
    await mk(40, [7, 30]);
    await mk(10, [1], true);
    const d = await dashboard();
    expect(d.panels.retention.days).toEqual([
      { day: 1, eligible: 2, returned: 1, rateBp: 5000 },
      { day: 7, eligible: 2, returned: 1, rateBp: 5000 },
      { day: 30, eligible: 1, returned: 1, rateBp: 10_000 },
    ]);
  });
});

describe("chunk 32: the client–server contract", () => {
  /** Timestamps and dates follow the clock; the SHAPE (what the client's guards check) does not. */
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "weekIndex" ? 0 : stable(x)]));
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return "2026-01-01T00:00:00.000Z";
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return "2026-01-01";
    return v;
  };
  it("records what the web client reads (apps/web/src/test/contract) and each body passes the client's guard", async () => {
    const p = await register("ctr");
    const recorded: [string, string, number, LightMyRequestResponse][] = [
      ["analytics", "GET /me/analytics", 200, await call(p, "GET", "/me/analytics")],
      ["analytics-put", "PUT /me/analytics", 200, await call(p, "PUT", "/me/analytics", { optedOut: false })],
      ["telemetry", "POST /me/telemetry", 202, await telemetry(p, [{ kind: "screen", screen: "town" }])],
      ["admin-dashboard", "GET /admin/dashboard", 200, await call(admin, "GET", `/admin/dashboard?week=${weekIndexAt(Date.now())}`)],
    ];
    const modPath = path.resolve(HERE, "../../web/src/test/contract/routes.ts");
    const { checkContract } = (await import(/* @vite-ignore */ modPath)) as { checkContract: (name: string, body: unknown) => string | null };
    const failures: string[] = [];
    for (const [name, route, status, res] of recorded) {
      expect(res.statusCode, `${route}: ${res.body}`).toBe(status);
      const body = stable(res.json());
      const why = checkContract(name, body);
      if (why) failures.push(`${name}: ${why}`);
      const file = path.resolve(HERE, `../../web/src/test/contract/${name}.json`);
      const text = `${JSON.stringify({ route, status, body }, null, 2)}\n`;
      if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
    }
    expect(failures).toEqual([]);
  });
});

describe("chunk 32: the §20 tuning table", () => {
  it("names all fourteen PROJECT.md §20 numbers, each with at least one existing panel and only real registry keys", () => {
    expect(TUNING_MAP.map((t) => t.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const project = readFileSync(path.resolve(HERE, "../../../PROJECT.md"), "utf8");
    const section = project.slice(project.indexOf("## 20. Open Numbers"), project.indexOf("**Theming (resolved):**"));
    expect(section.split("\n").filter((l) => l.startsWith("- ")).length).toBe(14);
    const reg = TUNABLES as unknown as Record<string, unknown>;
    for (const t of TUNING_MAP) {
      expect(t.panels.length, t.number).toBeGreaterThan(0);
      for (const p of t.panels) expect(PANEL_IDS as readonly string[], `${t.number}: ${p}`).toContain(p);
      for (const k of t.tunables) {
        if (k.endsWith("*")) expect(Object.keys(reg).some((r) => r.startsWith(k.slice(0, -1))), k).toBe(true);
        else expect(k in reg, `${t.number}: ${k}`).toBe(true);
      }
      expect(Object.keys(dash.panels)).toEqual(expect.arrayContaining(t.panels));
    }
    expect(Object.keys(dash.panels).sort()).toEqual([...PANEL_IDS].sort());
    // QA D3: each number's PRIMARY panel reads a field of the number's own subsystem; #1 and #4 have their own panels.
    for (const t of TUNING_MAP) expect(PANEL_SUBSYSTEMS[t.panels[0]!], `${t.n} ${t.number}`).toContain(t.subsystem);
    expect(TUNING_MAP[0]!.panels.slice(0, 2)).toEqual(["matchups", "mergeLevels"]);
    expect(TUNING_MAP[3]!.panels[0]).toBe("fences");
    expect(Object.keys(dash.tunableValues)).toEqual(expect.arrayContaining(["WEEKLY_PAY_CEILING", "TRIPS_PER_HOUR_CAP", "LADDER_RUNGS_PER_POOL", "BATTLE_LENGTH_CAP_SECONDS"]));
  });

  it("the dashboard over the app role equals the same build over the owner (it only reads)", async () => {
    const before = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_event")).rows[0]!.n;
    const d = await buildDashboard(appRole, { nowMs: Date.now(), days: 30, week: weekIndexAt(Date.now()) });
    expect(d.panels.bankVsPush).toEqual(dash.panels.bankVsPush);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_event")).rows[0]!.n).toBe(before);
  });
});

describe("chunk 32: admin access", () => {
  it("/admin/* is a 404 for no token, a bad token, and a signed-in non-admin — never 401/403 — and reads exactly like an unknown route (QA N1)", async () => {
    const unknown = async (url: string, method: "GET" | "POST" = "GET"): Promise<unknown> => {
      const r = await app.inject({ method, url: url.replace("/admin", "/no-such-route") });
      expect(r.statusCode).toBe(404);
      return JSON.parse(r.body.replace("/no-such-route", "/admin"));
    };
    for (const url of ["/admin/dashboard", "/admin/anything", "/admin/", "/admin", "/admin/dashboard?days=7"]) {
      for (const p of [null, { ...owner, token: "nope" }, owner]) {
        for (const method of ["GET", "POST"] as const) {
          const res = await call(p, method, url);
          expect([method, url, res.statusCode]).toEqual([method, url, 404]);
          expect(res.json(), `${method} ${url}`).toEqual(await unknown(url, method));
        }
      }
    }
    expect((await call(admin, "GET", "/admin/dashboard?days=7")).json().window.days).toBe(7);
  });

  it("QA N2: days and week are plain bounded integers (no 1e308, 0x10, sign or future week) — 400, never a 500", async () => {
    const current = weekIndexAt(Date.now());
    for (const q of ["days=0", "days=0x10", "days=1e1", "days=-5", "days=121", "days=99999999", "week=1e308", "week=-99999999999", "week=99999999999999", `week=${current + 1}`, "week=abc"]) {
      expect((await call(admin, "GET", `/admin/dashboard?${q}`)).statusCode, q).toBe(400);
    }
  });

  it("revoking turns the admin back into a 404; the flag is never carried on /me", async () => {
    const me = await call(admin, "GET", "/me");
    expect(me.body).not.toMatch(/admin/i);
    await revokeAdmin(pool, admin.username);
    expect((await call(admin, "GET", "/admin/dashboard")).statusCode).toBe(404);
    await grantAdmin(pool, admin.username, "telemetry-test");
    expect((await call(admin, "GET", "/admin/dashboard")).statusCode).toBe(200);
  });

  it("the app role (what every route runs as) cannot grant, change or revoke admin", async () => {
    for (const sql of [
      ["INSERT INTO account_admin (account_id, granted_by) VALUES ($1, 'me')", [owner.accountId]],
      ["UPDATE account_admin SET granted_by = 'x' WHERE account_id = $1", [admin.accountId]],
      ["DELETE FROM account_admin WHERE account_id = $1", [admin.accountId]],
    ] as const) {
      const err = await expectDbError(appRole, sql[0], [...sql[1]]);
      expect(err?.code, sql[0]).toBe("42501");
    }
    await expect(grantAdmin(appRole, owner.username, "self")).rejects.toThrow(/permission denied/);
    expect((await call(owner, "GET", "/admin/dashboard")).statusCode).toBe(404);
  });

  it("no route writes account_admin: only the CLI module and the migration name it", () => {
    const src = path.resolve(HERE, "../src");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const full = path.join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (/(INSERT INTO|UPDATE|DELETE FROM)\s+account_admin/.test(readFileSync(full, "utf8"))) hits.push(path.relative(src, full));
      }
    };
    walk(src);
    expect(hits).toEqual([path.join("analytics", "admin.ts")]);
  });
});

describe("chunk 32: opt-out and privacy", () => {
  it("opt-out is a server-side setting: ingest keeps nothing, and opting out deletes what was kept", async () => {
    const p = await register("opt");
    expect((await call(p, "GET", "/me/analytics")).json()).toEqual({ optedOut: false });
    expect((await telemetry(p, [{ kind: "screen", screen: "town" }])).json()).toEqual({ accepted: 1, dropped: 0, optedOut: false });
    const id = (await pool.query<{ analytics_id: string }>("SELECT analytics_id FROM account_analytics WHERE account_id = $1", [p.accountId])).rows[0]!.analytics_id;
    expect(id).not.toBe(p.accountId);
    const kept = async (): Promise<number> => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM analytics_client_event WHERE analytics_id = $1", [id])).rows[0]!.n;
    expect(await kept()).toBe(1);
    expect((await call(p, "PUT", "/me/analytics", { optedOut: true })).json()).toEqual({ optedOut: true });
    expect(await kept()).toBe(0);
    expect((await telemetry(p, [{ kind: "screen", screen: "town" }])).json()).toEqual({ accepted: 0, dropped: 1, optedOut: true });
    expect(await kept()).toBe(0);
    expect((await call(p, "GET", "/me/analytics")).json()).toEqual({ optedOut: true });
    expect((await call(p, "PUT", "/me/analytics", { optedOut: false })).json()).toEqual({ optedOut: false });
    expect((await call(p, "PUT", "/me/analytics", { optedOut: "no" })).statusCode).toBe(400);
    expect((await call(p, "PUT", "/me/analytics", { optedOut: true, extra: 1 })).statusCode).toBe(400);
    expect((await call(null, "GET", "/me/analytics")).statusCode).toBe(401);
  });

  it("rows carry the opaque id, never the account id or username; they cascade with the account", async () => {
    const p = await register("prv");
    await telemetry(p, [{ kind: "screen", screen: "webs" }, { kind: "crash", screen: "webs", errorName: "Error", stackHash: "12345678" }]);
    const rows = (await pool.query("SELECT ce.* FROM analytics_client_event ce JOIN account_analytics x USING (analytics_id) WHERE x.account_id = $1", [p.accountId])).rows;
    expect(rows).toHaveLength(2);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(p.accountId);
    expect(text).not.toContain(p.username);
    const cols = (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'analytics_client_event' ORDER BY ordinal_position")).rows.map((r) => r.column_name);
    expect(cols).toEqual(["id", "analytics_id", "kind", "screen", "error_name", "stack_hash", "occurred_at", "received_at", "client_session", "client_seq", "client_idx"]);
    await pool.query("DELETE FROM account WHERE id = $1", [p.accountId]);
    expect((await pool.query("SELECT 1 FROM account_analytics WHERE account_id = $1", [p.accountId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM analytics_client_event WHERE analytics_id = $1", [rows[0].analytics_id])).rowCount).toBe(0);
  });

  it("the app role cannot rewrite a stored event or move an analytics id", async () => {
    const p = await register("grd");
    await telemetry(p, [{ kind: "screen", screen: "town" }]);
    expect((await expectDbError(appRole, "UPDATE analytics_client_event SET screen = 'party'"))?.code).toBe("42501");
    expect((await expectDbError(appRole, "UPDATE account_analytics SET analytics_id = gen_random_uuid() WHERE account_id = $1", [p.accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "INSERT INTO analytics_client_event (analytics_id, kind, screen, occurred_at) SELECT analytics_id, 'screen', 'Hello there', now() FROM account_analytics WHERE account_id = $1", [p.accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "INSERT INTO analytics_client_event (analytics_id, kind, screen, occurred_at) SELECT analytics_id, 'screen', 'town', now() + interval '1 day' FROM account_analytics WHERE account_id = $1", [p.accountId]))?.code).toBe("23514");
  });
});

describe("chunk 32: ingest limits", () => {
  it("refuses unknown screens, unknown keys, free text, a bad hash, an empty or oversized batch, and a body over the cap", async () => {
    const p = await register("lim");
    const env = { session: 9, seq: 0 };
    const bad: unknown[] = [
      { ...env, events: [] },
      { ...env, events: Array.from({ length: 26 }, () => ({ kind: "screen", screen: "town" })) },
      { ...env, events: [{ kind: "screen", screen: "nowhere" }] },
      { ...env, events: [{ kind: "screen", screen: "town", username: p.username }] },
      { ...env, events: [{ kind: "crash", screen: "town", errorName: "Error", stackHash: "xyz" }] },
      { ...env, events: [{ kind: "crash", screen: "town", errorName: "Cannot read property of undefined", stackHash: "12345678" }] },
      { ...env, events: [{ kind: "screen", screen: "town", agoMs: -1 }] },
      { ...env, events: [{ kind: "click", screen: "town" }] },
      { ...env, events: [{ kind: "screen", screen: "town" }], note: "hi" },
      { events: [{ kind: "screen", screen: "town" }] },
      { session: 0, seq: 0, events: [{ kind: "screen", screen: "town" }] },
      { session: 1.5, seq: 0, events: [{ kind: "screen", screen: "town" }] },
      { session: 1, seq: -1, events: [{ kind: "screen", screen: "town" }] },
    ];
    // Two players, so the refusals stay under the per-account rate limit (each refused batch still counts).
    const p2 = await register("lim");
    for (const [i, body] of bad.entries()) expect((await call(i < 8 ? p : p2, "POST", "/me/telemetry", body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    const huge = await call(p2, "POST", "/me/telemetry", JSON.stringify({ events: [{ kind: "screen", screen: "town", pad: "x".repeat(5000) }] }), { "content-type": "application/json" });
    expect(huge.statusCode).toBe(413);
    expect((await call(null, "POST", "/me/telemetry", { events: [{ kind: "screen", screen: "town" }] })).statusCode).toBe(401);
  });

  it("rate-limits batches per account (429 with Retry-After), and keeps at most the daily cap per id", async () => {
    const p = await register("rate");
    const q = await register("rate");
    const codes: number[] = [];
    for (let i = 0; i < 13; i++) codes.push((await telemetry(p, [{ kind: "screen", screen: "town" }])).statusCode);
    expect(codes.slice(0, 12).every((c) => c === 202)).toBe(true);
    const limited = await telemetry(p, [{ kind: "screen", screen: "town" }]);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await telemetry(q, [{ kind: "screen", screen: "town" }])).statusCode).toBe(202); // per account
    // The daily cap: fill to one below, then a batch of three keeps one.
    await pool.query(
      `INSERT INTO analytics_client_event (analytics_id, kind, screen, occurred_at)
       SELECT x.analytics_id, 'screen', 'town', now() - interval '1 hour' FROM account_analytics x, generate_series(1, $2) WHERE x.account_id = $1`,
      [q.accountId, TELEMETRY_DAILY_EVENT_CAP - 2],
    );
    const r = await telemetry(q, [{ kind: "screen", screen: "town" }, { kind: "screen", screen: "party" }, { kind: "screen", screen: "webs" }]);
    expect(r.json()).toEqual({ accepted: 1, dropped: 2, optedOut: false });
  });

  it("QA D2: a replayed batch stores nothing, and an event's age is clamped to the flush window (so a session cannot be faked long)", async () => {
    const p = await register("rep");
    const events = Array.from({ length: 25 }, (_, i) => ({ kind: "screen", screen: i % 2 ? "town" : "trail", agoMs: 3_600_000 - i * 150_000 }));
    const first = await call(p, "POST", "/me/telemetry", { session: 42, seq: 0, events });
    const again = await call(p, "POST", "/me/telemetry", { session: 42, seq: 0, events });
    expect(first.json()).toEqual({ accepted: 25, dropped: 0, optedOut: false });
    expect(again.json()).toEqual({ accepted: 0, dropped: 25, optedOut: false });
    const span = (await pool.query<{ n: number; span_ms: number; max_age_ms: number }>(
      `SELECT count(*)::int AS n, floor(EXTRACT(EPOCH FROM max(ce.occurred_at) - min(ce.occurred_at)) * 1000)::int AS span_ms,
              floor(EXTRACT(EPOCH FROM max(ce.received_at - ce.occurred_at)) * 1000)::int AS max_age_ms
         FROM analytics_client_event ce JOIN account_analytics x USING (analytics_id) WHERE x.account_id = $1`,
      [p.accountId],
    )).rows[0]!;
    expect(span.n).toBe(25);
    expect(span.max_age_ms).toBeLessThanOrEqual(TELEMETRY_FLUSH_WINDOW_MS);
    expect(span.span_ms).toBeLessThanOrEqual(TELEMETRY_FLUSH_WINDOW_MS); // not the claimed hour
    // A heartbeat is a screen-shaped event.
    expect((await call(p, "POST", "/me/telemetry", { session: 42, seq: 1, events: [{ kind: "heartbeat", screen: "town" }] })).json()).toEqual({ accepted: 1, dropped: 0, optedOut: false });
    expect((await call(p, "POST", "/me/telemetry", { session: 42, seq: 2, events: [{ kind: "heartbeat", screen: "town", errorName: "Error" }] })).statusCode).toBe(400);
  });

  it("QA S2: an opt-out racing a batch in flight never leaves a row behind (50 concurrent pairs)", async () => {
    const p = await register("race");
    let leftover = 0;
    for (let i = 0; i < 50; i++) {
      await saveSettings(appRole, p.accountId, { optedOut: false });
      await Promise.all([ingest(appRole, p.accountId, { session: 5, seq: i, events: [{ kind: "screen", screen: "inbox", agoMs: 0 }] }, Date.now()), saveSettings(appRole, p.accountId, { optedOut: true })]);
      leftover += (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM analytics_client_event ce JOIN account_analytics x USING (analytics_id) WHERE x.account_id = $1", [p.accountId])).rows[0]!.n;
    }
    expect(leftover).toBe(0);
  });

  it("the limiter's memory is bounded", () => {
    const l = new TelemetryRateLimiter(2, 1000, 5);
    for (let i = 0; i < 50; i++) expect(l.take(`k${i}`, 0).ok).toBe(true);
    expect(l.size).toBeLessThanOrEqual(5);
    expect(l.take("z", 0).ok).toBe(true);
    expect(l.take("z", 1).ok).toBe(true);
    expect(l.take("z", 2)).toEqual({ ok: false, retryAfterMs: 998 });
    expect(l.take("z", 1000).ok).toBe(true);
  });

  it("the server's screen list is the web client's", async () => {
    const mod = (await import(/* @vite-ignore */ path.resolve(HERE, "../../web/src/telemetry/screens.ts"))) as { TELEMETRY_SCREENS: readonly string[]; TELEMETRY_ERROR_NAMES: readonly string[] };
    expect([...mod.TELEMETRY_SCREENS]).toEqual([...TELEMETRY_SCREENS]);
  });
});

describe("chunk 32: analytics never feed back into play", () => {
  it("nothing outside src/analytics and its routes file reads the analytics module or tables", () => {
    const src = path.resolve(HERE, "../src");
    // account/service.ts reads the account's own analytics for the export (QA D5) — out of play.
    const allowed = new Set([path.join("routes", "telemetry.ts"), "admin.ts", "app.ts", path.join("account", "service.ts")]);
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const full = path.join(dir, f);
        const rel = path.relative(src, full);
        if (statSync(full).isDirectory()) {
          if (rel !== "analytics") walk(full);
        } else if (/analytics_client_event|account_analytics|account_admin|\/analytics\//.test(readFileSync(full, "utf8")) && !allowed.has(rel)) hits.push(rel);
      }
    };
    walk(src);
    expect(hits).toEqual([]);
    // store-guards / economy-guards exempt exactly src/analytics/queries.ts from their "nobody else names
    // pack_purchase / coin_purchased / coin_spent" greps: that file is pure SELECT (no write verb at all).
    expect(readFileSync(path.join(src, "analytics", "queries.ts"), "utf8")).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM|appendEvents|appendCoinCredits|spendCoin)\b/);
    // And the analytics module itself never writes the ledger or any game table: its only writes are its own three tables.
    for (const f of readdirSync(path.join(src, "analytics"))) {
      const text = readFileSync(path.join(src, "analytics", f), "utf8");
      expect(text, f).not.toMatch(/appendEvents|appendCoinCredits|spendCoin|INSERT INTO ledger_event/);
      for (const m of text.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)) expect(["account_admin", "account_analytics", "analytics_client_event"], `${f}: ${m[0]}`).toContain(m[1]);
    }
    // QA N9: walk the packages recursively, so a subfolder cannot hide a reference.
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : [path.join(dir, f)]));
    for (const pkg of ["resolver", "circle", "content"]) {
      const all = files(path.resolve(HERE, `../../../packages/${pkg}/src`));
      expect(all.length).toBeGreaterThan(3);
      for (const f of all) expect(readFileSync(f, "utf8"), f).not.toMatch(/analytics|telemetry/i);
    }
  });
});

describe("chunk 32 QA D6: the dashboard is bounded", () => {
  it("runs in one READ ONLY transaction with a statement timeout", async () => {
    const seen: string[] = [];
    const spy: pg.Pool = new Proxy(appRole, {
      get(target, prop, recv) {
        if (prop !== "connect") return Reflect.get(target, prop, recv);
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, k, r) {
              if (k !== "query") return Reflect.get(c, k, r);
              return (sql: unknown, ...rest: unknown[]) => {
                if (typeof sql === "string") seen.push(sql);
                return (c.query as (...a: unknown[]) => unknown).call(c, sql, ...rest);
              };
            },
          });
        };
      },
    });
    await buildDashboard(spy, { nowMs: Date.now(), days: 30 });
    expect(seen.slice(0, 3)).toEqual(["BEGIN", "SET TRANSACTION READ ONLY", expect.stringMatching(/^SET LOCAL statement_timeout = \d+$/)]);
    expect(seen.at(-1)).toBe("COMMIT");
    expect(seen.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q))).toEqual([]);
  });

  it("rate-limits /admin/* per admin (429); a non-admin still only ever sees the 404", async () => {
    const codes: number[] = [];
    for (let i = 0; i <= ADMIN_REQUESTS_PER_MINUTE; i++) codes.push((await call(admin, "GET", "/admin/dashboard?days=1")).statusCode);
    expect(codes).toContain(429);
    expect((await call(owner, "GET", "/admin/dashboard")).statusCode).toBe(404);
  });
});
