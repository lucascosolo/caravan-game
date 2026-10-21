/**
 * Chunk 29 — the in-app inbox (PHASE-2 §29). Driven through the routes on the server's own DB
 * role (caravan_app), with real resolutions written by the trip loop and the deterministic
 * double, so every strike item is checked against the ledger it is derived from:
 *
 *   - a party strike shows up for the party's OWNER with what happened (held / overran), where
 *     (the caravan's public name, the encounter), what it earned, and a replay link that the
 *     replay route answers for the owner;
 *   - strikes in one window are ONE item with a count; the totals are the results feed's;
 *   - the item never carries the defender's account id (nor their caravan id);
 *   - read state lives on the server, moves only forward, and a strike landing after a read
 *     makes its batch unread again; a stale mark cannot hide it;
 *   - per-category opt-out with the §29 defaults as amended by the final play-test review D7
 *     (strikes, party changes, refugees and the trip cap on; the mine and the packs off);
 *   - refugees arrived, trip cap refilled, mine near cap, packs rotated — derived from the
 *     timers that already exist, read-only;
 *   - nothing here writes to the ledger; the schema guards hold against caravan_app.
 *
 * Chunk 29 QA fixes: strikes resolve through the worker WITH the trip settle hooks, as the
 * running server does (N9) — and once through the server's own in-process worker with the real
 * resolver (D1); the fallback (lazy) settle is exercised only where it is the subject (S2).
 */
import { entryBand, type PartyConfig } from "@caravan/circle";
import { TUNABLES, weekBounds, weekIndexAt } from "@caravan/content";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import { appendCoinCredits } from "../src/economy/coin.js";
import { drain } from "../src/jobs/worker.js";
import { appendEvents } from "../src/ledger/ledger.js";
import { createUnitInstance } from "../src/repo/unitInstances.js";
import { doubleHandlers, type EncounterPlan } from "../src/dev/tripDouble.js";
import { REFUGEE_REFRESH_INTERVAL_MS } from "../src/acquisition/refugeeMenu.js";
import { finishItems, horizonStartMs, mineItem, packsItem, refugeeItem, strikeItem, strikeWindowOf, tripCapItem, type InboxStrike } from "../src/inbox/derive.js";
import { readInbox, readUnread } from "../src/inbox/service.js";
import { INBOX_CATEGORIES, INBOX_HORIZON_MS, INBOX_ITEMIZED_BATCHES, INBOX_MAX_STRIKE_ITEMS, INBOX_STRIKE_BATCH_WINDOW_MS, INBOX_STRIKES_PER_ITEM } from "../src/inbox/tunables.js";
import { getJob } from "../src/jobs/queue.js";
import { TRIP_CAP_REGEN_MS, TRIPS_PER_HOUR_CAP } from "../src/trip/cap.js";
import { TRIP_SETTLE_HOOKS } from "../src/trip/service.js";

/** The web badge's poll interval (apps/web/src/shell/inboxSignal.ts INBOX_POLL_MS): "within one poll" is the DoD's "within a minute". */
const INBOX_POLL_MS = 60_000;
import { appRolePool, expectDbError, testPool, truncateAll, unique, seasonCaravan } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const pool = testPool();
let appRole: pg.Pool;
let app: FastifyInstance;

interface Player {
  token: string;
  username: string;
  accountId: string;
  caravanId: string;
  caravanName: string;
}

async function register(prefix = "ib"): Promise<Player> {
  const username = unique(prefix);
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username, password: "correct horse battery", region: "desert" } });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json();
  await seasonCaravan(pool, b.caravan.id); // r2 S2: the trips a test starts are not the caravan's first
  return { token: b.token, username, accountId: b.account.id, caravanId: b.caravan.id, caravanName: b.caravan.name };
}

function call(p: Player, method: "GET" | "POST" | "PUT", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
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

async function makeOwner(): Promise<Player> {
  const o = await register("own");
  const res = await call(o, "PUT", "/me/party", partyOf(await giveUnits(o, ["desert.dust_rider", "desert.well_digger"])));
  expect(res.statusCode, res.body).toBe(200);
  return o;
}

/**
 * A defender rides out, chooses `owner`'s party at encounter 1 and commits (through `via`, default
 * the worker-less app). Returns the job id; nothing is resolved yet.
 */
async function commitAgainst(owner: Player, via: FastifyInstance = app): Promise<{ defender: Player; jobId: string }> {
  const d = await register("def");
  const units = await giveUnits(d, ["desert.dust_rider", "desert.dust_rider"]);
  expect((await call(d, "POST", `/caravans/${d.caravanId}/manifest`, { units, traps: [], fence: { tierId: "fence.brush_pile", count: 4 } })).statusCode).toBe(201);
  const trip = `/me/caravans/${d.caravanId}/trip`;
  expect((await call(d, "POST", `${trip}/start`)).statusCode).toBe(201);
  const s = await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/search`);
  expect(s.statusCode, s.body).toBe(201);
  const cand = (s.json().menu.candidates as { candidateId: string; owner: { displayName: string } }[]).find((c) => c.owner.displayName === owner.caravanName);
  expect(cand, `${owner.caravanName} (${owner.username}) is in the menu`).toBeDefined();
  expect((await call(d, "POST", `/me/caravans/${d.caravanId}/encounters/1/choose`, { candidateId: cand!.candidateId })).statusCode).toBe(200);
  const formation = { v: 3, fences: [{ ref: "f0", segment: 0 }], traps: [], posts: [...units].sort().map((ref, i) => ({ ref, cell: { x: 13 + i * 5, y: 13 }, stance: "guard" })) };
  expect((await call(d, "PUT", `/caravans/${d.caravanId}/encounters/1/formation`, formation)).statusCode).toBe(200);
  const c = await via.inject({ method: "POST", url: `${trip}/encounters/1/commit`, headers: { authorization: `Bearer ${d.token}` } });
  expect(c.statusCode, c.body).toBe(202);
  return { defender: d, jobId: c.json().jobId };
}

/**
 * `commitAgainst`, then the double resolves it with `plan`. By default through the worker WITH
 * the trip settle hooks, as the running server does (QA N9): the owner's credits land in the
 * completion transaction and the defender reads nothing. `hooks: false` leaves the settle to the
 * lazy fallback (the defender's next trip read), the path QA S2 is about.
 */
async function strike(owner: Player, plan: EncounterPlan, opts: { hooks?: boolean } = {}): Promise<{ defender: Player; jobId: string }> {
  const r = await commitAgainst(owner);
  const hooks = opts.hooks ?? true;
  await drain(appRole, { workerId: "inbox-test", handlers: doubleHandlers({ 1: plan }), retryBackoffMs: () => 0, ...(hooks ? TRIP_SETTLE_HOOKS : {}), onHookError: (e) => { throw e; } });
  if (hooks) {
    const settled = await pool.query("SELECT 1 FROM trip_encounter WHERE trip_id = $1", [(await getJob(pool, r.jobId))!.input["tripId"]]);
    expect(settled.rowCount, "settled in the completion transaction").toBe(1);
  }
  return r;
}

/** The marks "Mark all read" sends: every unread item the client is showing, at the version it shows. */
const shownMarks = (body: InboxBody) => body.items.filter((i) => i.unread).map((i) => ({ key: i.key, version: i.version }));

/** Fixture strikes at chosen instants (owner role, the shape chunk 13's handler writes), for horizon / paging tests. */
async function fixtureStrikes(owner: Player, defender: Player, atMs: readonly number[]): Promise<void> {
  for (const [i, at] of atMs.entries()) {
    await pool.query(
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, resolver_version, payload, occurred_at)
       VALUES ('party_served_as_encounter', $1, NULL, $2, 0, 1, $3::jsonb, to_timestamp($4 / 1000.0))`,
      [
        owner.accountId,
        `test:inbox:fx:${owner.accountId}:${i}`,
        JSON.stringify({ jobId: `fx:${owner.accountId}:${i}`, tripId: null, encounterIndex: 1, defenderAccountId: defender.accountId, defenderCaravanId: defender.caravanId, outcome: { kind: "caravan_held" } }),
        at,
      ],
    );
  }
}

/** The pool, counting its queries. */
function counting(db: pg.Pool): { db: pg.Pool; count: () => number; reset: () => void } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(t, p) {
      if (p === "query") return (...args: unknown[]) => { n++; return (t.query as (...a: unknown[]) => unknown)(...args); };
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { db: proxy, count: () => n, reset: () => { n = 0; } };
}

async function inbox(p: Player): Promise<InboxBody> {
  const res = await call(p, "GET", "/me/inbox");
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

interface InboxBody {
  items: { key: string; category: string; version: number; unread: boolean; occurredAt: string; detail: Record<string, unknown> & { strikes?: Record<string, unknown>[] } }[];
  unreadCount: number;
  olderStrikes: { batchesPastLimit: number; beforeHorizon: boolean } | null;
  ignored?: string[];
  preferences: { category: string; enabled: boolean; defaultEnabled: boolean }[];
  delivery: string;
}

async function ledgerCount(accountId: string): Promise<number> {
  return (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_event WHERE account_id = $1", [accountId])).rows[0]!.n;
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

// ─────────────────────────────────────────────────────────────────────────────────────────
// Pure derivation
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("inbox derivation (pure)", () => {
  const W = INBOX_STRIKE_BATCH_WINDOW_MS;
  const s = (seq: number, ms: number): InboxStrike => ({
    seq,
    occurredAt: new Date(ms).toISOString(),
    jobId: `job${seq}`,
    encounterIndex: 1,
    outcomeKind: "caravan_overrun",
    defender: { username: "u", caravanName: "c", regionId: "desert", departed: false },
    coinEarned: 1,
    coinTransferred: 0,
    coinDiscardedAtCap: 0,
    reputationDelta: 1,
    ladderPointsGained: 1,
  });
  const totals = (window: number, count: number, maxSeq: number, newestAtMs = window * W + 900) => ({ window, count, maxSeq, newestAtMs, held: 0, overran: count, stalemate: 0, coinEarned: count, coinTransferred: 0, coinDiscardedAtCap: 0, reputationDelta: count, ladderPointsGained: count });

  it("batches a window into one item: the count is the window's, only that window's strikes are listed, newest first", () => {
    const w = 500_000;
    const listed = [s(10, w * W + 5), s(12, w * W + 900), s(9, (w - 1) * W + 3)];
    const item = strikeItem(totals(w, INBOX_STRIKES_PER_ITEM + 3, 12), listed);
    expect(item.key).toBe(`strike:${w}`);
    expect(item.version).toBe(12);
    const d = item.detail as { count: number; strikes: InboxStrike[]; notListed: number; windowStartMs: number; windowEndMs: number; linesIncluded: boolean };
    expect(d.count).toBe(INBOX_STRIKES_PER_ITEM + 3);
    expect(d.linesIncluded).toBe(true);
    expect(d.strikes.map((x) => x.seq)).toEqual([12, 10]);
    expect(d.notListed).toBe(3);
    expect(d.windowStartMs).toBe(w * W);
    expect(d.windowEndMs).toBe((w + 1) * W);
    expect(item.occurredAtMs).toBe(w * W + 900);
    expect(strikeWindowOf(w * W + W - 1)).toBe(w);
    expect(strikeWindowOf(w * W + W)).toBe(w + 1);
    // QA S4: a batch sent without its lines says so, and still counts what it will never itemize.
    const bare = strikeItem(totals(w, 4, 12), null).detail as { strikes: InboxStrike[]; linesIncluded: boolean; notListed: number };
    expect(bare).toMatchObject({ strikes: [], linesIncluded: false, notListed: 0 });
  });

  it("QA N1: the horizon starts at a window start, so no batch is cut in half", () => {
    const now = 500_000 * W + 1_234_567;
    const since = horizonStartMs(now);
    expect(since % W).toBe(0);
    expect(since).toBeLessThanOrEqual(now - INBOX_HORIZON_MS);
    expect(since).toBeGreaterThan(now - INBOX_HORIZON_MS - W);
  });

  it("is unread until a mark reaches the item's version; a newer version is unread again", () => {
    const item = strikeItem(totals(1, 1, 40), []);
    expect(finishItems([item], new Map())[0]!.unread).toBe(true);
    expect(finishItems([item], new Map([[item.key, 40]]))[0]!.unread).toBe(false);
    expect(finishItems([item], new Map([[item.key, 39]]))[0]!.unread).toBe(true);
  });

  it("refugees: an item only once the free menu is owed, keyed by caravan and grid point", () => {
    const caravan = { id: "c1", name: "Wheels", regionId: "desert" };
    expect(refugeeItem(caravan, null, 100, 1_000)).toBeNull();
    expect(refugeeItem(caravan, { windowOpenedAtMs: 1_000, claimed: true }, 100, 1_099)).toBeNull();
    const item = refugeeItem(caravan, { windowOpenedAtMs: 1_000, claimed: false }, 100, 1_100)!;
    expect(item).toMatchObject({ key: "refugees:c1:1100", version: 1_100, detail: { caravanName: "Wheels", currentMenuUnclaimed: true } });
  });

  it("trip cap: an item at the instant every use is back; none before the first use or while uses are out", () => {
    expect(tripCapItem(0, 3, 5_000, 1e9)).toBeNull();
    expect(tripCapItem(6_000, 3, 5_000, 1e9)).toBeNull();
    expect(tripCapItem(4_000, 3, 5_000, 1e9)).toMatchObject({ key: "trip_cap:4000", detail: { available: 3, cap: 3, fullAtMs: 4_000 } });
    expect(tripCapItem(4_000, 3, 5_000, 500)).toBeNull(); // past the horizon
  });

  it("mine: near the cap at the threshold, says when the trickle stops, and none below it", () => {
    const base = { ledgerBalance: 44_000, cap: 50_000, accruedFromMs: 0, nextCoinInMs: 10, msPerCoin: 18_000, ratePerHour: 200, lastSpendSeq: 7, lastCreditMs: 0 };
    expect(mineItem({ ...base, balance: 44_999 }, 1_000_000, 90)).toBeNull();
    const near = mineItem({ ...base, balance: 45_000 }, 1_000_000_000, 90)!;
    expect(near).toMatchObject({ key: "mine:7", detail: { atCap: false, balance: 45_000, cap: 50_000 } });
    expect((near.detail as { capReachedAtMs: number }).capReachedAtMs).toBe(1_000_000_000 + 10 + 4_999 * 18_000);
    expect(mineItem({ ...base, balance: 50_000, ledgerBalance: 50_000 }, 1_000_000, 90)!.detail).toMatchObject({ atCap: true, capReachedAtMs: null });
  });

  it("packs: one item per week, never for a week that began before the account existed", () => {
    const week = { index: 3, startsAtMs: 1_000, endsAtMs: 2_000 };
    expect(packsItem(week, 1_500)).toBeNull();
    expect(packsItem(week, 900)).toMatchObject({ key: "packs:3", version: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Through the routes, against the ledger
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("party strikes in the owner's inbox", () => {
  let owner: Player;
  let held: { defender: Player; jobId: string };
  let overran: { defender: Player; jobId: string };

  beforeAll(async () => {
    // Strikes batch by fixed window: keep this block's strikes (about 15 s of work) clear of a
    // window boundary so "same window" is a fact of the fixture, not of the wall clock.
    const left = INBOX_STRIKE_BATCH_WINDOW_MS - (Date.now() % INBOX_STRIKE_BATCH_WINDOW_MS);
    if (left < 45_000) await new Promise((r) => setTimeout(r, left + 50));
    owner = await makeOwner();
    await makeOwner();
    await makeOwner(); // three parties in the band: a full candidate menu
    // QA N9: through the worker with the settle hooks, as production: no defender reads its trip.
    held = await strike(owner, { kind: "caravan_held" });
    overran = await strike(owner, { kind: "caravan_overrun" });
  });

  it("a fresh account has an empty inbox, the §29 defaults, and in-app delivery only", async () => {
    const p = await register();
    const body = await inbox(p);
    expect(body.items).toEqual([]);
    expect(body.unreadCount).toBe(0);
    expect(body.delivery).toBe("in_app");
    // Final play-test review D7: refugees and the trip cap are on by default (return hooks); S2's party changes too.
    const on = new Set(["party_strike", "refugees_arrived", "trip_cap_refilled", "party_changed"]);
    expect(body.preferences.map((x) => [x.category, x.enabled, x.defaultEnabled])).toEqual(INBOX_CATEGORIES.map((c) => [c, on.has(c), on.has(c)]));
    expect((await call(p, "GET", "/me/inbox/unread")).json()).toEqual({ unreadCount: 0 });
    expect((await app.inject({ method: "GET", url: "/me/inbox" })).statusCode).toBe(401);
  });

  it("two strikes in one window are ONE unread item with a count, both outcomes, and the feed's totals", async () => {
    const body = await inbox(owner);
    const strikes = body.items.filter((i) => i.category === "party_strike");
    expect(strikes).toHaveLength(1);
    const item = strikes[0]!;
    expect(item.unread).toBe(true);
    expect(body.unreadCount).toBe(1);
    expect(item.detail).toMatchObject({ count: 2, held: 1, overran: 1, stalemate: 0, other: 0, notListed: 0 });
    const feed = (await call(owner, "GET", "/me/party/feed")).json().entries as { jobId: string; coinEarned: number; coinTransferred: number; reputationDelta: number; ladderPointsGained: number; seq: number }[];
    expect(feed).toHaveLength(2);
    const sum = (k: "coinEarned" | "coinTransferred" | "reputationDelta" | "ladderPointsGained") => feed.reduce((a, e) => a + e[k], 0);
    expect(item.detail).toMatchObject({ coinEarned: sum("coinEarned"), coinTransferred: sum("coinTransferred"), reputationDelta: sum("reputationDelta"), ladderPointsGained: sum("ladderPointsGained") });
    // QA S2: the version is the newest seq among the strikes AND the owner-side events they caused.
    const causes = feed.flatMap((e) => [e.jobId, `progression:${e.jobId}`, `transfer:${e.jobId}`]);
    const newest = await pool.query<{ seq: number }>("SELECT max(seq) AS seq FROM ledger_event WHERE account_id = $1 AND causation_id = ANY($2::text[])", [owner.accountId, causes]);
    expect(item.version).toBe(Number(newest.rows[0]!.seq));
    expect(item.version).toBeGreaterThan(Math.max(...feed.map((e) => e.seq)));
    // Each strike: what happened, where, what it earned, and the replay link.
    const lines = item.detail.strikes!;
    expect(lines.map((l) => l["jobId"])).toEqual([overran.jobId, held.jobId]);
    expect(lines[0]).toMatchObject({ outcomeKind: "caravan_overrun", encounterIndex: 1, defender: { username: null, caravanName: overran.defender.caravanName, regionId: "desert" } });
    // Final play-test review r3 N6: a stranger's caravan name, never their username.
    expect(lines[1]).toMatchObject({ outcomeKind: "caravan_held", defender: { username: null, caravanName: held.defender.caravanName } });
    for (const l of lines) expect(JSON.stringify(l)).not.toContain(overran.defender.username);
    // The strike's Coin is what the feed credited for that very job.
    for (const l of lines) expect(l["coinEarned"]).toBe(feed.find((e) => e.jobId === l["jobId"])!.coinEarned);
  });

  it("never carries the struck player's account id (nor their caravan id)", async () => {
    const text = JSON.stringify(await inbox(owner));
    for (const d of [held.defender, overran.defender]) {
      expect(text).not.toContain(d.accountId);
      expect(text).not.toContain(d.caravanId);
    }
    expect(text).not.toMatch(/accountId/);
  });

  it("one tap from a strike lands on the replay: the route answers the owner for each listed job", async () => {
    const lines = (await inbox(owner)).items[0]!.detail.strikes!;
    for (const l of lines) {
      const r = await call(owner, "GET", `/me/encounters/${encodeURIComponent(String(l["jobId"]))}/replay`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().viewer).toBe("party_owner");
    }
  });

  it("the defender's inbox shows nothing of the party's side", async () => {
    expect((await inbox(held.defender)).items.filter((i) => i.category === "party_strike")).toEqual([]);
  });

  it("read state is the server's: marking clears the badge, a later strike re-opens the batch, a stale mark cannot hide it", async () => {
    const before = await inbox(owner);
    const item = before.items[0]!;
    const before_ledger = await ledgerCount(owner.accountId);
    const marked = await call(owner, "POST", "/me/inbox/read", { marks: [{ key: item.key, version: item.version }] });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().unreadCount).toBe(0);
    expect((await call(owner, "GET", "/me/inbox/unread")).json()).toEqual({ unreadCount: 0 });
    expect(await ledgerCount(owner.accountId), "reading writes no ledger event").toBe(before_ledger);

    // A third strike in the same window: the same item, a newer version, unread again.
    await strike(owner, { kind: "caravan_held" });
    const after = await inbox(owner);
    expect(after.items.filter((i) => i.category === "party_strike")).toHaveLength(1);
    const again = after.items[0]!;
    expect(again.key).toBe(item.key);
    expect(again.version).toBeGreaterThan(item.version);
    expect(again.unread).toBe(true);
    expect(again.detail["count"]).toBe(3);

    // A replayed stale mark (the old version) keeps it unread; a mark ABOVE the current version is clamped to it.
    expect((await call(owner, "POST", "/me/inbox/read", { marks: [{ key: item.key, version: item.version }] })).json().unreadCount).toBe(1);
    expect((await call(owner, "POST", "/me/inbox/read", { marks: [{ key: item.key, version: Number.MAX_SAFE_INTEGER }] })).json().unreadCount).toBe(0);
    const stored = await pool.query<{ version: number }>("SELECT version FROM inbox_read WHERE account_id = $1 AND item_key = $2", [owner.accountId, item.key]);
    expect(stored.rows[0]!.version).toBe(again.version);
  });

  it("QA S1: \"Mark all read\" marks what was on screen; a strike that landed after it rendered stays unread", async () => {
    const shown = await inbox(owner);
    expect(shown.unreadCount).toBe(0);
    await strike(owner, { kind: "caravan_held" }); // lands after the screen rendered
    const onScreen = shown.items.map((i) => ({ key: i.key, version: i.version })); // what the stale screen sends
    const marked = await call(owner, "POST", "/me/inbox/read", { marks: onScreen });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().unreadCount, "the new strike was never on screen").toBe(1);
    // Rendered again, "Mark all read" sends the new version and the batch is read.
    const fresh = marked.json() as InboxBody;
    expect((await call(owner, "POST", "/me/inbox/read", { marks: shownMarks(fresh) })).json().unreadCount).toBe(0);
  });

  it("QA S2: a settle that lands after the batch was read re-opens it with the new totals", async () => {
    const { defender } = await strike(owner, { kind: "caravan_overrun" }, { hooks: false });
    const before = (await inbox(owner)).items[0]!;
    expect((await call(owner, "POST", "/me/inbox/read", { marks: [{ key: before.key, version: before.version }] })).json().unreadCount).toBe(0);
    // The defender's trip read runs the lazy settle: the owner's Coin / Reputation / ladder land now, with higher seqs.
    expect((await call(defender, "GET", `/me/caravans/${defender.caravanId}/trip`)).statusCode).toBe(200);
    const after = (await inbox(owner)).items[0]!;
    expect(after.key).toBe(before.key);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.unread).toBe(true);
    expect(after.detail["coinEarned"] as number).toBeGreaterThan(before.detail["coinEarned"] as number);
    expect((await call(owner, "POST", "/me/inbox/read", { marks: [{ key: after.key, version: after.version }] })).json().unreadCount).toBe(0);
  });

  it("QA N6: with the owner at the storage cap, the batch and the line both carry what the cap discarded — the feed's numbers", async () => {
    const bal = (await pool.query<{ coin_balance: number }>("SELECT coin_balance FROM account WHERE id = $1", [owner.accountId])).rows[0]!.coin_balance;
    await withTransaction(pool, (c) => appendCoinCredits(c, { causationId: `test:inbox:cap:${owner.accountId}`, accountId: owner.accountId, credits: [{ amount: TUNABLES.COIN_STORAGE_CAP - Number(bal), reason: "test_setup" }] }));
    const { jobId } = await strike(owner, { kind: "caravan_overrun" });
    const feed = (await call(owner, "GET", "/me/party/feed")).json().entries as { jobId: string; coinEarned: number; coinDiscardedAtCap: number }[];
    const entry = feed.find((e) => e.jobId === jobId)!;
    expect(entry.coinDiscardedAtCap).toBeGreaterThan(0);
    expect(entry.coinEarned).toBe(0);
    const item = (await inbox(owner)).items[0]!;
    const line = item.detail.strikes!.find((l) => l["jobId"] === jobId)!;
    expect(line).toMatchObject({ coinEarned: 0, coinDiscardedAtCap: entry.coinDiscardedAtCap });
    expect(item.detail["coinDiscardedAtCap"]).toBe(feed.reduce((a, e) => a + e.coinDiscardedAtCap, 0));
  });

  it("QA D1: on the running server's own worker (real resolver, settle hooks, no test flag) the owner's inbox has the strike within one badge poll, and its replay plays", async () => {
    const live = await buildApp({ db: appRole, encounterWorker: { pollMs: 600_000 } });
    await live.ready();
    try {
      expect(live.encounterWorker?.name).toBe("resolver");
      const shown = await inbox(owner);
      if (shown.unreadCount > 0) await call(owner, "POST", "/me/inbox/read", { marks: shownMarks(shown) });
      const t0 = Date.now();
      const { jobId } = await commitAgainst(owner, live); // the commit kicks the in-process worker
      let unread = 0;
      while (unread === 0 && Date.now() - t0 < INBOX_POLL_MS) {
        await new Promise((r) => setTimeout(r, 50));
        unread = (await live.inject({ method: "GET", url: "/me/inbox/unread", headers: { authorization: `Bearer ${owner.token}` } })).json().unreadCount;
      }
      const elapsed = Date.now() - t0;
      expect(unread, "the strike reached the owner's badge").toBe(1);
      expect(elapsed).toBeLessThan(INBOX_POLL_MS);
      const job = (await getJob(pool, jobId))!;
      expect(job.status).toBe("completed");
      expect((job.result as { resolver: string }).resolver).toBe("resolver");
      // Settled by the hook: the trip has its encounter though the defender never read it, and the item's line is the feed's.
      expect((await pool.query("SELECT 1 FROM trip_encounter WHERE trip_id = $1", [job.input["tripId"]])).rowCount).toBe(1);
      const item = (await inbox(owner)).items[0]!;
      const line = item.detail.strikes!.find((l) => l["jobId"] === jobId)!;
      const entry = ((await call(owner, "GET", "/me/party/feed")).json().entries as { jobId: string; coinEarned: number; reputationDelta: number; ladderPointsGained: number }[]).find((e) => e.jobId === jobId)!;
      expect(line).toMatchObject({ coinEarned: entry.coinEarned, reputationDelta: entry.reputationDelta, ladderPointsGained: entry.ladderPointsGained });
      expect(entry.ladderPointsGained, "the owner's progression landed at resolution").toBeGreaterThan(0);
      // One tap: the replay route answers the owner with the STORED log of that very fight.
      const replay = await call(owner, "GET", `/me/encounters/${encodeURIComponent(jobId)}/replay`);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({ viewer: "party_owner", renderable: true, reason: null });
      expect(replay.json().log).not.toBeNull();
    } finally {
      await live.close();
    }
  });

  it("QA N4: stores nothing for keys the inbox is not showing, and says so instead of failing the request; refuses malformed bodies", async () => {
    const other = await register();
    const ownersKey = (await inbox(owner)).items[0]!.key;
    const r = await call(other, "POST", "/me/inbox/read", { marks: [{ key: ownersKey, version: 1 }, { key: "trip_cap:1", version: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().ignored).toEqual([ownersKey, "trip_cap:1"]);
    // QA S1: there is no "mark everything" any more — only the marks the client is showing.
    for (const bad of [null, [], {}, { all: true }, { all: false }, { all: true, marks: [] }, { marks: [] }, { marks: [{ key: ownersKey }] }, { marks: [{ key: ownersKey, version: -1 }] }, { marks: [{ key: ownersKey, version: 1, extra: 1 }] }, { nope: 1 }]) {
      const b = await call(other, "POST", "/me/inbox/read", bad);
      expect(b.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await pool.query("SELECT 1 FROM inbox_read WHERE account_id = $1", [other.accountId])).rowCount).toBe(0);
  });

  it("QA N2: one key sent twice is one mark, at the higher of its (clamped) versions — not a 500", async () => {
    const o = await register("dup");
    await fixtureStrikes(o, held.defender, [Date.now() - 1_000]);
    const item = (await inbox(o)).items[0]!;
    const r = await call(o, "POST", "/me/inbox/read", { marks: [{ key: item.key, version: item.version }, { key: item.key, version: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().unreadCount).toBe(0);
    const stored = await pool.query<{ version: number }>("SELECT version FROM inbox_read WHERE account_id = $1", [o.accountId]);
    expect(stored.rows.map((x) => Number(x.version))).toEqual([item.version]);
  });

  it("ten strikes in one window are one item with a count of ten, itemizing the newest INBOX_STRIKES_PER_ITEM", async () => {
    const o = await register("ten");
    const drafts = Array.from({ length: 10 }, (_, i) => ({
      type: "party_served_as_encounter" as const,
      accountId: o.accountId,
      resolverVersion: 1,
      payload: { jobId: `ten:${o.accountId}:${i}`, tripId: null, encounterIndex: 1 + (i % 3), defenderAccountId: held.defender.accountId, defenderCaravanId: held.defender.caravanId, outcome: { kind: i % 2 ? "caravan_held" : "caravan_overrun" } },
    }));
    // Fixture: the shape chunk 13's handler writes, one causation each, all within this window.
    for (const [i, d] of drafts.entries()) await withTransaction(pool, (c) => appendEvents(c, `test:inbox:ten:${o.accountId}:${i}`, [d]));
    const body = await inbox(o);
    const strikes = body.items.filter((i) => i.category === "party_strike");
    // Ten writes inside one second can straddle a window boundary at most once.
    const total = strikes.reduce((a, i) => a + (i.detail["count"] as number), 0);
    expect(total).toBe(10);
    expect(strikes.length).toBeLessThanOrEqual(2);
    if (strikes.length === 1) expect(strikes[0]!.detail).toMatchObject({ count: 10, held: 5, overran: 5, notListed: 10 - INBOX_STRIKES_PER_ITEM });
    expect(JSON.stringify(body)).not.toContain(held.defender.accountId);
    // Mark all: the marks of what is on screen.
    const all = await call(o, "POST", "/me/inbox/read", { marks: shownMarks(body) });
    expect(all.json().unreadCount).toBe(0);
  });

  it("opting out of strikes hides them from the list and the badge; opting back in restores them", async () => {
    const o = await register("opt");
    await withTransaction(pool, (c) =>
      appendEvents(c, `test:inbox:opt:${o.accountId}`, [
        { type: "party_served_as_encounter", accountId: o.accountId, resolverVersion: 1, payload: { jobId: `opt:${o.accountId}`, tripId: null, encounterIndex: 1, defenderAccountId: held.defender.accountId, defenderCaravanId: held.defender.caravanId, outcome: { kind: "caravan_held" } } },
      ]),
    );
    expect((await call(o, "GET", "/me/inbox/unread")).json().unreadCount).toBe(1);
    const off = await call(o, "PUT", "/me/inbox/preferences", { preferences: { party_strike: false } });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ items: [], unreadCount: 0 });
    expect(off.json().preferences.find((p: { category: string }) => p.category === "party_strike")).toEqual({ category: "party_strike", enabled: false, defaultEnabled: true });
    expect((await call(o, "GET", "/me/inbox/unread")).json().unreadCount).toBe(0);
    expect((await call(o, "PUT", "/me/inbox/preferences", { preferences: { party_strike: true } })).json().unreadCount).toBe(1);
    for (const bad of [{ preferences: { nope: true } }, { preferences: { party_strike: "yes" } }, { preferences: {} }, {}, { preferences: { party_strike: true }, x: 1 }]) {
      expect((await call(o, "PUT", "/me/inbox/preferences", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("QA D2 / N1 / S4: the horizon, the 30-batch limit, and a bounded read", () => {
  const W = INBOX_STRIKE_BATCH_WINDOW_MS;
  let defender: Player;
  beforeAll(async () => {
    defender = await register("fxdef");
  });

  it("N1: a batch the horizon would split is shown whole (its count is the feed's for that hour); past it, the inbox says older activity is in the feed", async () => {
    const o = await register("hz");
    const win = Math.floor(Date.now() / W) - 30; // a window well in the past
    const at = [win * W + 600_000, win * W + 1_200_000, win * W + 1_800_000];
    await fixtureStrikes(o, defender, at);
    // Read at "strike 2 + 14 d − 5 ms": the raw cutoff falls between strikes 1 and 2.
    const edge = await readInbox(appRole, o.accountId, at[1]! + INBOX_HORIZON_MS - 5);
    expect(edge.items).toHaveLength(1);
    expect(edge.items[0]!.detail).toMatchObject({ count: 3 });
    expect(edge.olderStrikes).toBeNull();
    // Once the whole window is past the horizon: no item, and one pointer to the feed.
    const past = await readInbox(appRole, o.accountId, (win + 1) * W + INBOX_HORIZON_MS + W);
    expect(past.items).toEqual([]);
    expect(past.olderStrikes).toEqual({ batchesPastLimit: 0, beforeHorizon: true });
  });

  it("D2 + S4: past the 30th batch the inbox says how many batches it is not showing; only the newest batches carry lines, the rest are fetched; the read is a fixed handful of queries", async () => {
    const o = await register("many");
    const nowWin = Math.floor(Date.now() / W);
    const batches = INBOX_MAX_STRIKE_ITEMS + 2;
    // Two strikes in each of 32 past windows.
    await fixtureStrikes(o, defender, Array.from({ length: batches }, (_, k) => [(nowWin - 1 - k) * W + 60_000, (nowWin - 1 - k) * W + 120_000]).flat());
    const q = counting(appRole);
    const body = await readInbox(q.db, o.accountId, Date.now());
    const readQueries = q.count();
    expect(body.items).toHaveLength(INBOX_MAX_STRIKE_ITEMS);
    expect(body.olderStrikes).toEqual({ batchesPastLimit: 2, beforeHorizon: false });
    const strikes = body.items.map((i) => i.detail as { linesIncluded: boolean; strikes: unknown[]; count: number });
    expect(strikes.slice(0, INBOX_ITEMIZED_BATCHES).every((d) => d.linesIncluded && d.strikes.length === 2)).toBe(true);
    expect(strikes.slice(INBOX_ITEMIZED_BATCHES).every((d) => !d.linesIncluded && d.strikes.length === 0 && d.count === 2)).toBe(true);
    // Preferences, the windows, the lines (rows + siblings + caravans), the marks — plus one each for the
    // categories on by default since the final play-test review (refugees, trip cap, party changes): never one query per batch.
    expect(readQueries).toBeLessThanOrEqual(10);
    q.reset();
    await readUnread(q.db, o.accountId, Date.now());
    expect(q.count()).toBeLessThanOrEqual(6);
    // A batch without its lines: the client fetches them on demand.
    const last = body.items.at(-1)!;
    const lines = await call(o, "GET", `/me/inbox/strikes/${last.key.slice("strike:".length)}`);
    expect(lines.statusCode, lines.body).toBe(200);
    expect(lines.json().strikes).toHaveLength(2);
    expect(JSON.stringify(lines.json())).not.toContain(defender.accountId);
    expect(JSON.stringify(lines.json())).not.toContain(defender.caravanId);
    expect((await call(o, "GET", "/me/inbox/strikes/nope")).statusCode).toBe(400);
    // Confirmation review N2: a window after the current one (or one so large its timestamp overflows) is a 400, never a 500.
    expect((await call(o, "GET", "/me/inbox/strikes/2600000000")).statusCode).toBe(400);
    expect((await call(o, "GET", "/me/inbox/strikes/999999999999999")).statusCode).toBe(400);
    // "Mark all read" over a full inbox fits one request.
    expect((await call(o, "POST", "/me/inbox/read", { marks: body.items.map((i) => ({ key: i.key, version: i.version })) })).json().unreadCount).toBe(0);
  });
});

describe("timers in the inbox (read-only)", () => {
  it("refugees arrived: a free menu owed at the drip's grid point, on by default (D7), off when opted out, without touching the menu", async () => {
    const p = await register("ref");
    expect((await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`)).statusCode).toBe(200); // bootstraps menu 1
    const menu = (await pool.query<{ window_opened_at_ms: number }>("SELECT window_opened_at_ms FROM refugee_menu WHERE caravan_id = $1", [p.caravanId])).rows[0]!;
    const due = Number(menu.window_opened_at_ms) + REFUGEE_REFRESH_INTERVAL_MS;
    expect((await readInbox(appRole, p.accountId, due + 1)).items).toHaveLength(1); // on by default (final play-test review D7)
    await call(p, "PUT", "/me/inbox/preferences", { preferences: { refugees_arrived: false } });
    expect((await readInbox(appRole, p.accountId, due + 1)).items).toEqual([]); // opted out
    await call(p, "PUT", "/me/inbox/preferences", { preferences: { refugees_arrived: true } });
    expect((await readInbox(appRole, p.accountId, due - 1)).items).toEqual([]);
    const body = await readInbox(appRole, p.accountId, due + 1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ category: "refugees_arrived", unread: true, detail: { caravanId: p.caravanId, caravanName: p.caravanName, arrivedAtMs: due, currentMenuUnclaimed: true } });
    const rows = await pool.query("SELECT sequence FROM refugee_menu WHERE caravan_id = $1", [p.caravanId]);
    expect(rows.rowCount, "the inbox never takes or writes a menu").toBe(1);
  });

  it("trip cap refilled: an item at the instant every use is back", async () => {
    const p = await register("cap");
    await call(p, "PUT", "/me/inbox/preferences", { preferences: { trip_cap_refilled: true } });
    const units = await giveUnits(p, ["desert.dust_rider"]);
    expect((await call(p, "POST", `/caravans/${p.caravanId}/manifest`, { units, traps: [], fence: null })).statusCode).toBe(201);
    const t0 = Date.now();
    expect((await call(p, "POST", `/me/caravans/${p.caravanId}/trip/start`)).statusCode).toBe(201);
    const tat = Number((await pool.query<{ tat_ms: number }>("SELECT tat_ms FROM trip_cap WHERE account_id = $1", [p.accountId])).rows[0]!.tat_ms);
    expect(tat).toBeGreaterThanOrEqual(t0 + TRIP_CAP_REGEN_MS);
    expect((await readInbox(appRole, p.accountId, tat - 1)).items).toEqual([]);
    const body = await readInbox(appRole, p.accountId, tat);
    expect(body.items).toEqual([expect.objectContaining({ category: "trip_cap_refilled", key: `trip_cap:${tat}`, detail: { available: TRIPS_PER_HOUR_CAP, cap: TRIPS_PER_HOUR_CAP, fullAtMs: tat } })]);
  });

  it("mine near cap: from the trickle's read-only peek, and the read writes no ledger event", async () => {
    const p = await register("mine");
    await call(p, "PUT", "/me/inbox/preferences", { preferences: { mine_near_cap: true } });
    expect((await inbox(p)).items).toEqual([]);
    await withTransaction(pool, (c) => appendCoinCredits(c, { causationId: `test:inbox:mine:${p.accountId}`, accountId: p.accountId, credits: [{ amount: TUNABLES.COIN_STORAGE_CAP - 100, reason: "test_setup" }] }));
    const n = await ledgerCount(p.accountId);
    const body = await inbox(p);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ category: "mine_near_cap", detail: { cap: TUNABLES.COIN_STORAGE_CAP, atCap: false } });
    expect(body.items[0]!.detail["balance"]).toBeGreaterThanOrEqual(TUNABLES.COIN_STORAGE_CAP - 100);
    expect(await ledgerCount(p.accountId)).toBe(n);
  });

  it("packs rotated: one item for a week that began after the account existed; it states the rotation and nothing else", async () => {
    const p = await register("packs");
    await call(p, "PUT", "/me/inbox/preferences", { preferences: { packs_rotated: true } });
    expect((await inbox(p)).items, "this week began before the account").toEqual([]);
    const next = weekIndexAt(Date.now()) + 1;
    const body = await readInbox(appRole, p.accountId, weekBounds(next).startsAtMs + 1);
    expect(body.items).toEqual([expect.objectContaining({ category: "packs_rotated", key: `packs:${next}`, detail: { weekIndex: next, ...weekBounds(next) } })]);
  });
});

describe("schema guards against caravan_app (migrations 015 and 018)", () => {
  it("read marks only move forward, keys are shaped, categories are known; no TRUNCATE, no trigger toggling", async () => {
    const p = await register("guard");
    await appRole.query("INSERT INTO inbox_read (account_id, item_key, version) VALUES ($1, 'strike:1', 5)", [p.accountId]);
    expect((await expectDbError(appRole, "UPDATE inbox_read SET version = 4 WHERE account_id = $1", [p.accountId]))?.message).toMatch(/only moves forward/);
    expect((await expectDbError(appRole, "UPDATE inbox_read SET item_key = 'strike:2' WHERE account_id = $1", [p.accountId]))?.message).toMatch(/immutable/);
    expect(await expectDbError(appRole, "UPDATE inbox_read SET version = 6 WHERE account_id = $1", [p.accountId])).toBeNull();
    expect((await expectDbError(appRole, "INSERT INTO inbox_read (account_id, item_key, version) VALUES ($1, 'no key shape', 1)", [p.accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "INSERT INTO inbox_read (account_id, item_key, version) VALUES ($1, 'strike:3', -1)", [p.accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "INSERT INTO inbox_preference (account_id, category, enabled) VALUES ($1, 'store_deals', true)", [p.accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "TRUNCATE inbox_read"))?.code).toBe("42501");
    expect((await expectDbError(appRole, "ALTER TABLE inbox_read DISABLE TRIGGER inbox_read_forward_only"))?.code).toBe("42501");
    expect((await expectDbError(appRole, "DROP TRIGGER inbox_read_forward_only ON inbox_read"))?.code).toBe("42501");
    // QA N3: nor DELETE + re-INSERT at a lower version; only the account's own cascade removes marks.
    expect((await expectDbError(appRole, "DELETE FROM inbox_read WHERE account_id = $1", [p.accountId]))?.message).toMatch(/only moves forward/);
    expect((await expectDbError(appRole, "ALTER TABLE inbox_read DISABLE TRIGGER inbox_read_guard_delete"))?.code).toBe("42501");
    expect((await pool.query<{ version: number }>("SELECT version FROM inbox_read WHERE account_id = $1", [p.accountId])).rows.map((r) => Number(r.version))).toEqual([6]);
    await pool.query("DELETE FROM account WHERE id = $1", [p.accountId]);
    expect((await pool.query("SELECT 1 FROM inbox_read WHERE account_id = $1", [p.accountId])).rowCount).toBe(0);
  });

  it("the inbox module never writes the ledger, never reaches the store or a debit, and never reads a defender account id into a response", () => {
    const dir = join(HERE, "../src/inbox");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/appendEvents|appendCoinCredits|spendCoin|accrueTrickle|from "\.\.\/store\//);
      expect(src, f).not.toMatch(/INSERT INTO ledger_event|UPDATE ledger_event/);
      expect(src, f).not.toMatch(/defenderAccountId/);
    }
  });
});
