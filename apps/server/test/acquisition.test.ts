/**
 * Chunk 18: the refugee drip and mercenary recruit. The central check is GUARDRAILS §3 —
 * Coin cannot, by any path, produce an instance of a type the caravan has not reached in
 * its living web — followed by determinism of the menu (seeded, stored, replayable; the
 * pick is never random), the reroll buying time and nothing else, the safety valve (recruit
 * always available for every unlocked type), idempotent claims and purchases under retries
 * and races, the storage guard, legibility, the split, and the rebuild walkthrough.
 */
import { LIVING_UNIT_TYPES, TUNABLES, unitsForRegion } from "@caravan/content";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drawForSequence, drawRefugeeMenu, fnv1a32, menuSeed, replayMenu, rerollCost, REFUGEE_REFRESH_INTERVAL_MS } from "../src/acquisition/refugeeMenu.js";
import { claimRefugee, refreshRefugees, rerollRefugees, viewRefugees } from "../src/acquisition/refugees.js";
import { recruitMercenary, viewRecruit } from "../src/acquisition/recruit.js";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/pool.js";
import type { RefugeeMenuRow } from "../src/db/types.js";
import { appendCoinCredits, readCoinBalance, spendCoin } from "../src/economy/coin.js";
import { mergeCost } from "../src/economy/merge.js";
import { readTrickleAccrualPoint } from "../src/economy/trickle.js";
import { appendEvents, listEventsForAccount } from "../src/ledger/ledger.js";
import { verifyProjection } from "../src/ledger/projection.js";
import { setCaravanState } from "../src/repo/caravans.js";
import { createUnitInstance, listUnitInstancesForCaravan } from "../src/repo/unitInstances.js";
import { AppError } from "../src/services/errors.js";
import { reachedNodeIds } from "../src/unlocks/access.js";
import { testPool, truncateAll, unique } from "./helpers.js";

const pool: pg.Pool = testPool();
let app: FastifyInstance;

const INTERVAL = REFUGEE_REFRESH_INTERVAL_MS;
const RECRUIT = TUNABLES.MERCENARY_COST_BASE;
const SCHEDULE = TUNABLES.REFUGEE_REROLL_COST_SCHEDULE;
const CAP = TUNABLES.UNIT_INVENTORY_CAP;

type Region = "desert" | "mountain";
interface Player {
  token: string;
  accountId: string;
  caravanId: string;
  regionId: Region;
}

async function registerPlayer(region: Region = "desert"): Promise<Player> {
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { username: unique("u"), password: "correct horse battery", region } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, accountId: body.account.id, caravanId: body.caravan.id, regionId: region };
}

function call(p: Player, method: "GET" | "POST", url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${p.token}` } };
  if (payload !== undefined) opts.payload = payload as NonNullable<InjectOptions["payload"]>;
  return app.inject(opts);
}

const owner = (p: Player) => ({ accountId: p.accountId, caravanId: p.caravanId, regionId: p.regionId });

const rungCounters: Record<string, number> = {};
/** TEST FIXTURE: unlock points as chunk 04's rung crossing would grant them (counting down from the top rung). */
async function grantLiving(p: Player, points: number): Promise<void> {
  const key = `${p.caravanId}:living`;
  const n = (rungCounters[key] = (rungCounters[key] ?? 0) + 1);
  const rung = 21 - n;
  await withTransaction(pool, (c) =>
    appendEvents(c, `test:grant:${p.accountId}:living:${rung}`, [
      { type: "unlock_points_granted", accountId: p.accountId, caravanId: p.caravanId, payload: { pool: "living", points, rung } },
    ]),
  );
}

/** Reach a living node through the real chunk 05 spend route. */
async function unlock(p: Player, nodeId: string): Promise<void> {
  const res = await call(p, "POST", "/me/unlocks/spend", { pool: "living", nodeId, caravanId: p.caravanId });
  expect(res.statusCode, res.body).toBe(201);
}

/** Set a balance by writing earn/spend events (the only way to move it). */
async function setBalance(accountId: string, target: number): Promise<void> {
  const { balance } = await readCoinBalance(pool, accountId);
  const tag = unique("set");
  await withTransaction(pool, async (c) => {
    if (target > balance) await appendCoinCredits(c, { causationId: `test:${tag}`, accountId, credits: [{ amount: target - balance, reason: "test_setup" }] });
    else if (target < balance) await spendCoin(c, accountId, balance - target, "test_setup", await readTrickleAccrualPoint(pool, accountId), { causationId: `test:${tag}` });
  });
}

/** Pretend every menu so far was generated `ms` earlier (the free-timer grid moves with it; it is the only clock the drip reads). */
async function backdateWindow(caravanId: string, ms: number): Promise<void> {
  await pool.query("UPDATE refugee_menu SET generated_at_ms = generated_at_ms - $2, window_opened_at_ms = window_opened_at_ms - $2 WHERE caravan_id = $1", [caravanId, ms]);
}

async function menuRows(caravanId: string): Promise<RefugeeMenuRow[]> {
  return (await pool.query<RefugeeMenuRow>("SELECT * FROM refugee_menu WHERE caravan_id = $1 ORDER BY sequence", [caravanId])).rows;
}

async function unitAcquiredEvents(accountId: string) {
  return (await listEventsForAccount(pool, accountId, { limit: 500 })).filter((e) => e.event_type === "unit_acquired");
}

async function spentEvents(accountId: string) {
  return (await listEventsForAccount(pool, accountId, { limit: 500 })).filter((e) => e.event_type === "coin_spent");
}

async function appErr(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected an AppError");
}

/** A snapshot of everything an acquisition could touch, to prove a refusal wrote nothing. */
async function snapshot(p: Player) {
  const roster = await listUnitInstancesForCaravan(pool, p.caravanId);
  const events = await listEventsForAccount(pool, p.accountId, { limit: 500 });
  const menus = await menuRows(p.caravanId);
  const { balance } = await readCoinBalance(pool, p.accountId);
  return JSON.stringify({ roster: roster.map((r) => r.id), events: events.map((e) => e.seq), menus: menus.map((m) => [m.sequence, m.claimed_type_id]), balance });
}

const DESERT_STARTERS = ["desert.dust_rider", "desert.well_digger"];
const DESERT_LOCKED_T1 = "desert.sand_sharpshooter";

beforeAll(async () => {
  await truncateAll(pool);
  app = await buildApp({ db: pool });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the menu draw is pure, seeded and reproducible (GUARDRAILS §1)", () => {
  const POOL8 = unitsForRegion("desert").map((u) => u.id);

  it("fnv1a32 and menuSeed are stable functions of their inputs", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    const id = "0f2d7d4e-8f5a-4c0a-9c7e-2b1d0e9a6b3c";
    expect(menuSeed(id, 1)).toBe(menuSeed(id.toUpperCase(), 1));
    expect(menuSeed(id, 1)).not.toBe(menuSeed(id, 2));
    expect(() => menuSeed(id, 0)).toThrow(RangeError);
  });

  it("the same seed and pool always yield the same 3; the pool's iteration order does not matter", () => {
    const a = drawRefugeeMenu(POOL8, 12345);
    const b = drawRefugeeMenu([...POOL8].reverse(), 12345);
    const c = drawRefugeeMenu(new Set([...POOL8, ...POOL8]), 12345);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.offers).toHaveLength(TUNABLES.REFUGEE_OFFER_COUNT);
    expect(new Set(a.offers).size).toBe(3);
    for (const o of a.offers) expect(POOL8).toContain(o);
    expect(drawRefugeeMenu(POOL8, 12346).offers).not.toEqual(a.offers);
  });

  it("a pool smaller than the offer count still yields exactly 3 offers, all from the pool", () => {
    for (let seed = 0; seed < 200; seed++) {
      const { offers } = drawRefugeeMenu(DESERT_STARTERS, seed);
      expect(offers).toHaveLength(3);
      for (const o of offers) expect(DESERT_STARTERS).toContain(o);
      // Without replacement first: the two distinct types are always both present.
      expect(new Set(offers.slice(0, 2)).size).toBe(2);
    }
    const one = drawRefugeeMenu(["desert.dust_rider"], 7);
    expect(one.offers).toEqual(["desert.dust_rider", "desert.dust_rider", "desert.dust_rider"]);
    expect(() => drawRefugeeMenu([], 1)).toThrow(RangeError);
  });

  it("is uniform over the pool: every type is offered in about 3/8 of menus, in every slot", () => {
    const N = 20_000;
    const perType = new Map<string, number>(POOL8.map((id) => [id, 0]));
    const perSlot = Array.from({ length: 3 }, () => new Map<string, number>(POOL8.map((id) => [id, 0])));
    for (let seed = 1; seed <= N; seed++) {
      const { offers } = drawRefugeeMenu(POOL8, seed);
      offers.forEach((o, slot) => {
        perType.set(o, perType.get(o)! + 1);
        perSlot[slot]!.set(o, perSlot[slot]!.get(o)! + 1);
      });
    }
    for (const id of POOL8) {
      expect(perType.get(id)! / N).toBeGreaterThan(0.35);
      expect(perType.get(id)! / N).toBeLessThan(0.40);
      for (const slot of perSlot) {
        expect(slot.get(id)! / N).toBeGreaterThan(0.105);
        expect(slot.get(id)! / N).toBeLessThan(0.145);
      }
    }
  });

  it("the reroll schedule escalates 150/300/600 and then holds at the last value", () => {
    expect([0, 1, 2, 3, 10].map(rerollCost)).toEqual([150, 300, 600, 600, 600]);
    expect(() => rerollCost(-1)).toThrow(RangeError);
  });

  it("the module reads no clock and uses no Math.random", () => {
    const src = readFileSync(join(__dirname, "../src/acquisition/refugeeMenu.ts"), "utf8");
    expect(src).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|crypto/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("refugee drip: menu, timer, claim", () => {
  it("a fresh caravan gets a stored menu of exactly 3 from its 2 starting types, with the timer, reroll cost and balance", async () => {
    const p = await registerPlayer();
    const res = await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`);
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json();
    expect(v.menu.sequence).toBe(1);
    expect(v.menu.origin).toBe("free");
    expect(v.menu.rerollsThisWindow).toBe(0);
    expect(v.menu.offers).toHaveLength(3);
    expect(v.menu.poolTypeIds).toEqual(DESERT_STARTERS);
    for (const o of v.menu.offers) {
      expect(DESERT_STARTERS).toContain(o.unitTypeId);
      expect(typeof o.displayName).toBe("string");
      expect(o.ability.archetype).toBeTruthy();
    }
    expect(v.menu.claimed).toBeNull();
    expect(v.timer.intervalMs).toBe(INTERVAL);
    expect(v.timer.nextFreeRefreshAtMs - v.timer.windowOpenedAtMs).toBe(INTERVAL);
    expect(v.timer.msUntilFreeRefresh).toBeGreaterThan(INTERVAL - 5_000);
    expect(v.timer.refreshedNow).toBe(true);
    expect(v.reroll).toMatchObject({ nextCost: 150, nextIndex: 0, schedule: [150, 300, 600], affordable: false, forfeitsUnclaimedOffer: true });
    expect(v.inventory).toMatchObject({ cap: CAP });
    expect(typeof v.balance).toBe("number");

    // Stored, and replayable from the row alone.
    const rows = await menuRows(p.caravanId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seed).toBe(menuSeed(p.caravanId, 1));
    expect(replayMenu(rows[0]!).ok).toBe(true);
    expect(rows[0]!.offered_type_ids).toEqual(v.menu.offers.map((o: { unitTypeId: string }) => o.unitTypeId));

    // A second read is the same menu, no new row, no refresh.
    const again = await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`);
    expect(again.json().menu).toEqual(v.menu);
    expect(again.json().timer.refreshedNow).toBe(false);
    expect(await menuRows(p.caravanId)).toHaveLength(1);
  });

  it("the player's pick yields exactly that type at level 1 on the caravan, with one unit_acquired event; one pick per menu", async () => {
    const p = await registerPlayer();
    const v = (await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`)).json();
    const pick = v.menu.offers[1].unitTypeId as string;
    const other = v.menu.offers.find((o: { unitTypeId: string }) => o.unitTypeId !== pick)?.unitTypeId as string | undefined;
    const before = (await listUnitInstancesForCaravan(pool, p.caravanId)).length;

    const res = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: pick, sequence: 1 });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.replayed).toBe(false);
    expect(body.acquired).toMatchObject({ unitTypeId: pick, mergeLevel: 1, source: "refugee", coinCost: 0, menuSequence: 1 });
    expect(body.instance).toMatchObject({ caravan_id: p.caravanId, unit_type_id: pick, merge_level: 1 });
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(["unit_acquired"]);
    expect(body.refugees.menu.claimed).toMatchObject({ unitTypeId: pick, instanceId: body.instance.id });
    expect(body.refugees.reroll.forfeitsUnclaimedOffer).toBe(false);

    const roster = await listUnitInstancesForCaravan(pool, p.caravanId);
    expect(roster.length).toBe(before + 1);
    const acquired = await unitAcquiredEvents(p.accountId);
    expect(acquired).toHaveLength(1);
    expect(acquired[0]!.caravan_id).toBe(p.caravanId);
    expect(await spentEvents(p.accountId)).toHaveLength(0);

    // Same pick again: a replay, nothing new.
    const retry = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: pick, sequence: 1 });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().replayed).toBe(true);
    expect(retry.json().acquired.instanceId).toBe(body.instance.id);
    expect((await listUnitInstancesForCaravan(pool, p.caravanId)).length).toBe(before + 1);

    // A different pick from the same menu: refused, nothing written.
    if (other) {
      const snap = await snapshot(p);
      const second = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: other, sequence: 1 });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("menu_claimed");
      expect(await snapshot(p)).toBe(snap);
    }
  });

  it("a type that is not on the menu is refused, even when it is unlocked", async () => {
    const p = await registerPlayer();
    const v = (await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`)).json();
    const offered = new Set(v.menu.offers.map((o: { unitTypeId: string }) => o.unitTypeId));
    const notOffered = DESERT_STARTERS.find((id) => !offered.has(id));
    if (!notOffered) return; // both starters offered on this seed; nothing to refuse
    const snap = await snapshot(p);
    const res = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: notOffered, sequence: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_offered");
    expect(await snapshot(p)).toBe(snap);
  });

  it("8 concurrent claims of one menu produce exactly one instance and one event", async () => {
    const p = await registerPlayer();
    const v = await viewRefugees(pool, owner(p));
    const pick = v.menu.offers[0]!.unitTypeId;
    const results = await Promise.all(Array.from({ length: 8 }, () => claimRefugee(pool, { ...owner(p), unitTypeId: pick, sequence: v.menu.sequence })));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(7);
    const ids = new Set(results.map((r) => r.acquired.instanceId));
    expect(ids.size).toBe(1);
    expect((await listUnitInstancesForCaravan(pool, p.caravanId)).filter((r) => r.unit_type_id === pick)).toHaveLength(1);
    expect(await unitAcquiredEvents(p.accountId)).toHaveLength(1);
    expect((await verifyProjection(pool, p.accountId)).ok).toBe(true);
  });

  it("the free timer: no new menu before the interval; after it the GET reports it due and writes nothing; taking it yields ONE free menu on the grid, which resets the reroll window", async () => {
    const p = await registerPlayer();
    const t0 = 1_700_000_000_000;
    const first = await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    expect(first.menu.sequence).toBe(1);
    expect(first.timer.freeRefreshDue).toBe(false);
    // Claim, then wait just under the interval: same (claimed) menu.
    await claimRefugee(pool, { ...owner(p), unitTypeId: first.menu.offers[0]!.unitTypeId, sequence: 1, nowMs: t0 + 1 });
    const early = await viewRefugees(pool, { ...owner(p), nowMs: t0 + INTERVAL - 1 });
    expect(early.menu.sequence).toBe(1);
    expect(early.menu.claimed).not.toBeNull();
    expect(early.timer.msUntilFreeRefresh).toBe(1);
    expect(early.timer.freeRefreshDue).toBe(false);
    expect(early.timer.refreshedNow).toBe(false);
    // Ten intervals later the GET says the free menu is owed — and leaves everything alone (D1/S2).
    const late = await viewRefugees(pool, { ...owner(p), nowMs: t0 + 10 * INTERVAL + 5 });
    expect(late.menu.sequence).toBe(1);
    expect(late.timer).toMatchObject({ freeRefreshDue: true, msUntilFreeRefresh: 0, refreshedNow: false, nextFreeRefreshAtMs: t0 + INTERVAL });
    expect(late.reroll.blockedByFreeRefresh).toBe(true);
    expect(await menuRows(p.caravanId)).toHaveLength(1);
    // Taking it: ONE new free menu (no stockpiling), on the grid (D2): window 10, not "now".
    const taken = await refreshRefugees(pool, { ...owner(p), fromSequence: 1, nowMs: t0 + 10 * INTERVAL + 5 });
    expect(taken.replayed).toBe(false);
    expect(taken.forfeitedOffers).toBeNull(); // menu 1 was claimed; nothing lost
    expect(taken.produced).toMatchObject({ sequence: 2, origin: "free", rerollsThisWindow: 0, claimed: null });
    expect(taken.view.timer).toMatchObject({ refreshedNow: true, windowOpenedAtMs: t0 + 10 * INTERVAL, nextFreeRefreshAtMs: t0 + 11 * INTERVAL, msUntilFreeRefresh: INTERVAL - 5, freeRefreshDue: false });
    expect(taken.view.reroll).toMatchObject({ nextCost: 150, nextIndex: 0, blockedByFreeRefresh: false });
    expect(await menuRows(p.caravanId)).toHaveLength(2);
    // The old, claimed menu replays its stored pick and grants nothing new.
    const replay = await claimRefugee(pool, { ...owner(p), unitTypeId: first.menu.offers[0]!.unitTypeId, sequence: 1, nowMs: t0 + 10 * INTERVAL + 6 });
    expect(replay.replayed).toBe(true);
    expect(await unitAcquiredEvents(p.accountId)).toHaveLength(1);
  });

  it("an unclaimed menu is never expired by the timer alone (D1): a claim past the timer succeeds and takes the due refresh in the same request; only an explicit refresh forfeits it", async () => {
    const p = await registerPlayer();
    const t0 = 1_700_000_000_000;
    const first = await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    // The reviewer's probe: picked at 89:59, the request lands at 90:01.
    const late = await claimRefugee(pool, { ...owner(p), unitTypeId: first.menu.offers[0]!.unitTypeId, sequence: 1, nowMs: t0 + INTERVAL + 1 });
    expect(late.replayed).toBe(false);
    expect(late.acquired.unitTypeId).toBe(first.menu.offers[0]!.unitTypeId);
    // ...and the free menu the timer owed arrived with it, anchored to the grid.
    expect(late.view.menu).toMatchObject({ sequence: 2, origin: "free", claimed: null });
    expect(late.view.timer).toMatchObject({ refreshedNow: true, windowOpenedAtMs: t0 + INTERVAL, nextFreeRefreshAtMs: t0 + 2 * INTERVAL });
    const rows = await menuRows(p.caravanId);
    expect(rows.map((r) => [r.sequence, r.origin, r.claimed_type_id !== null])).toEqual([[1, "free", true], [2, "free", false]]);
    // Menu 2 sits unclaimed past its timer: still claimable, until the player forfeits it explicitly.
    const stillThere = await viewRefugees(pool, { ...owner(p), nowMs: t0 + 5 * INTERVAL });
    expect(stillThere.menu).toMatchObject({ sequence: 2, claimed: null });
    expect(stillThere.timer.freeRefreshDue).toBe(true);
    const forfeited = await refreshRefugees(pool, { ...owner(p), fromSequence: 2, nowMs: t0 + 5 * INTERVAL });
    expect(forfeited.forfeitedOffers!.map((o) => o.unitTypeId)).toEqual(stillThere.menu.offers.map((o) => o.unitTypeId));
    expect(forfeited.produced.sequence).toBe(3);
    const err = await appErr(claimRefugee(pool, { ...owner(p), unitTypeId: stillThere.menu.offers[0]!.unitTypeId, sequence: 2, nowMs: t0 + 5 * INTERVAL + 1 }));
    expect(err.code).toBe("menu_expired");
    expect(await unitAcquiredEvents(p.accountId)).toHaveLength(1);
    // The menus were drawn from (caravan, sequence) only: regenerating from stored inputs matches, whatever the clock said.
    for (const row of await menuRows(p.caravanId)) expect(replayMenu(row).ok).toBe(true);
    const bySeed = drawRefugeeMenu(DESERT_STARTERS, menuSeed(p.caravanId, 2)).offers;
    expect(late.view.menu.offers.map((o) => o.unitTypeId)).toEqual(bySeed);
  });

  it("through HTTP: backdating the window makes the next read report a due refresh; POST /refresh takes it", async () => {
    const p = await registerPlayer();
    await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`);
    await backdateWindow(p.caravanId, INTERVAL);
    const res = await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`);
    expect(res.json().menu.sequence).toBe(1);
    expect(res.json().timer).toMatchObject({ freeRefreshDue: true, refreshedNow: false });
    expect(await menuRows(p.caravanId)).toHaveLength(1);
    const take = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/refresh`, { fromSequence: 1 });
    expect(take.statusCode, take.body).toBe(201);
    expect(take.json().produced.sequence).toBe(2);
    expect(take.json().forfeitedOffers).toHaveLength(3);
    expect(take.json().refugees.timer.refreshedNow).toBe(true);
    const again = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/refresh`, { fromSequence: 1 });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(await menuRows(p.caravanId)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("refugee reroll: Coin buys a sooner menu, never a wider or better one (GUARDRAILS §2/§3)", () => {
  it("costs 150, 300, 600, 600 within a window through spendCoin; each menu is from the same pool; the free timer never moves", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 5_000);
    const t0 = 1_700_000_000_000;
    const v0 = await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    const anchor = v0.timer.windowOpenedAtMs;
    const costs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await rerollRefugees(pool, { ...owner(p), fromSequence: i + 1, nowMs: t0 + 1000 * (i + 1) });
      expect(r.replayed).toBe(false);
      costs.push(r.coinCost);
      expect(r.produced.sequence).toBe(i + 2);
      expect(r.produced.origin).toBe("reroll");
      expect(r.produced.rerollsThisWindow).toBe(i + 1);
      expect(r.produced.poolTypeIds).toEqual(DESERT_STARTERS);
      for (const o of r.produced.offers) expect(DESERT_STARTERS).toContain(o.unitTypeId);
      expect(r.view.timer.windowOpenedAtMs).toBe(anchor);
      expect(r.view.timer.nextFreeRefreshAtMs).toBe(anchor + INTERVAL);
      expect(r.events[0]!.payload).toMatchObject({ reason: "refugee_reroll", amount: costs[i], rerollIndex: i, fromSequence: i + 1, toSequence: i + 2 });
    }
    expect(costs).toEqual([150, 300, 600, 600]);
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(5_000 - 1650);
    expect(await spentEvents(p.accountId)).toHaveLength(4);
    for (const row of await menuRows(p.caravanId)) expect(replayMenu(row).ok).toBe(true);
    // The window opener is still menu 1; the free refresh is due on time, a fifth reroll is refused unpaid, and taking it resets the price.
    const due = await viewRefugees(pool, { ...owner(p), nowMs: anchor + INTERVAL });
    expect(due.menu.sequence).toBe(5);
    expect(due.timer.freeRefreshDue).toBe(true);
    expect((await appErr(rerollRefugees(pool, { ...owner(p), fromSequence: 5, nowMs: anchor + INTERVAL }))).code).toBe("free_refresh_due");
    expect(await spentEvents(p.accountId)).toHaveLength(4);
    const free = await refreshRefugees(pool, { ...owner(p), fromSequence: 5, nowMs: anchor + INTERVAL });
    expect(free.produced).toMatchObject({ sequence: 6, origin: "free" });
    expect(free.view.timer).toMatchObject({ windowOpenedAtMs: anchor + INTERVAL, nextFreeRefreshAtMs: anchor + 2 * INTERVAL });
    expect(free.view.reroll.nextCost).toBe(150);
    expect((await verifyProjection(pool, p.accountId)).ok).toBe(true);
  });

  it("insufficient Coin: refused, no menu, no charge; and the view shows the cost and affordability beforehand", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 100);
    const v = (await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`)).json();
    expect(v.reroll).toMatchObject({ nextCost: 150, affordable: false });
    const snap = await snapshot(p);
    const res = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/reroll`, { fromSequence: v.menu.sequence });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_coin");
    expect(await snapshot(p)).toBe(snap);
  });

  it("a retried reroll (same fromSequence) is charged once; a stale fromSequence is refused", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 2_000);
    await viewRefugees(pool, owner(p));
    const results = await Promise.all(Array.from({ length: 5 }, () => rerollRefugees(pool, { ...owner(p), fromSequence: 1 })));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.produced.sequence === 2)).toBe(true);
    expect(await spentEvents(p.accountId)).toHaveLength(1);
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(2_000 - 150);
    const stale = await appErr(rerollRefugees(pool, { ...owner(p), fromSequence: 7 }));
    expect(stale.code).toBe("stale_menu");
    expect(await spentEvents(p.accountId)).toHaveLength(1);
  });

  it("50 rerolls never offer anything outside the unlocked pool; unlocking a node in the web is what widens it", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, TUNABLES.COIN_STORAGE_CAP);
    const seen = new Set<string>();
    let seq = (await viewRefugees(pool, owner(p))).menu.sequence;
    for (let i = 0; i < 50; i++) {
      if ((await readCoinBalance(pool, p.accountId)).balance < 600) await setBalance(p.accountId, TUNABLES.COIN_STORAGE_CAP);
      const r = await rerollRefugees(pool, { ...owner(p), fromSequence: seq });
      seq = r.produced.sequence;
      for (const o of r.produced.offers) seen.add(o.unitTypeId);
    }
    expect([...seen].sort()).toEqual(DESERT_STARTERS);
    expect(seen.has(DESERT_LOCKED_T1)).toBe(false);
    // Now reach a node through the web: the pool the NEXT menus draw from includes it.
    await grantLiving(p, 5);
    await unlock(p, DESERT_LOCKED_T1);
    const widened = new Set<string>();
    for (let i = 0; i < 40; i++) {
      if ((await readCoinBalance(pool, p.accountId)).balance < 600) await setBalance(p.accountId, TUNABLES.COIN_STORAGE_CAP);
      const r = await rerollRefugees(pool, { ...owner(p), fromSequence: seq });
      seq = r.produced.sequence;
      expect(r.produced.poolTypeIds).toEqual([...DESERT_STARTERS, DESERT_LOCKED_T1].sort());
      for (const o of r.produced.offers) widened.add(o.unitTypeId);
    }
    expect(widened.has(DESERT_LOCKED_T1)).toBe(true);
    for (const row of await menuRows(p.caravanId)) expect(replayMenu(row).ok).toBe(true);
  });

  it("a reroll is refused, unpaid, while a free refresh is due (Coin is never charged for a menu the timer owed); taking the free one unblocks it", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 1_000);
    const t0 = 1_700_000_000_000;
    await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    const r = await appErr(rerollRefugees(pool, { ...owner(p), fromSequence: 1, nowMs: t0 + INTERVAL }));
    expect(r.code).toBe("free_refresh_due");
    expect(await spentEvents(p.accountId)).toHaveLength(0);
    expect(await menuRows(p.caravanId)).toHaveLength(1);
    const v = await viewRefugees(pool, { ...owner(p), nowMs: t0 + INTERVAL });
    expect(v.menu.sequence).toBe(1);
    expect(v.reroll.blockedByFreeRefresh).toBe(true);
    const free = await refreshRefugees(pool, { ...owner(p), fromSequence: 1, nowMs: t0 + INTERVAL });
    expect(free.produced).toMatchObject({ sequence: 2, origin: "free" });
    const paid = await rerollRefugees(pool, { ...owner(p), fromSequence: 2, nowMs: t0 + INTERVAL + 1 });
    expect(paid).toMatchObject({ replayed: false, coinCost: 150 });
    expect(paid.produced).toMatchObject({ sequence: 3, origin: "reroll", rerollsThisWindow: 1 });
    expect(paid.view.timer.windowOpenedAtMs).toBe(t0 + INTERVAL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("mercenary recruit: exact pick, Coin, guaranteed, always available", () => {
  it("the price list shows every unlocked type at MERCENARY_COST_BASE and the locked ones as not for sale", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 1_000);
    const res = await call(p, "GET", `/me/caravans/${p.caravanId}/recruit`);
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.costBase).toBe(RECRUIT);
    expect(v.scaling).toBe("none");
    expect(v.recruitable.map((r: { unitTypeId: string }) => r.unitTypeId)).toEqual(DESERT_STARTERS);
    for (const r of v.recruitable) expect(r).toMatchObject({ cost: RECRUIT, affordable: true });
    expect(v.locked.map((r: { unitTypeId: string }) => r.unitTypeId)).toEqual(
      unitsForRegion("desert").map((u) => u.id).filter((id) => !DESERT_STARTERS.includes(id)).sort(),
    );
    expect(v.availability).toEqual({ cooldown: null, dailyLimit: null });
    expect(v.balance).toBe(1_000);
    expect(v.inventory).toMatchObject({ cap: CAP });
  });

  it("a purchase: one level-1 instance, coin_spent + unit_acquired under one cause, balance down by the cost", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 1_000);
    const res = await call(p, "POST", `/me/caravans/${p.caravanId}/recruit`, { unitTypeId: "desert.well_digger" });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.replayed).toBe(false);
    expect(body.acquired).toMatchObject({ unitTypeId: "desert.well_digger", mergeLevel: 1, source: "mercenary", coinCost: RECRUIT });
    expect(body.instance).toMatchObject({ caravan_id: p.caravanId, unit_type_id: "desert.well_digger", merge_level: 1 });
    expect(body.coinCost).toBe(RECRUIT);
    expect(body.balanceAfter).toBe(1_000 - RECRUIT);
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(["coin_spent", "unit_acquired"]);
    const spent = await spentEvents(p.accountId);
    expect(spent).toHaveLength(1);
    expect(spent[0]!.payload).toMatchObject({ reason: "mercenary_recruit", amount: RECRUIT, unitTypeId: "desert.well_digger" });
    expect(spent[0]!.caravan_id).toBeNull(); // Coin is account-level
    const acquired = await unitAcquiredEvents(p.accountId);
    expect(acquired[0]!.caravan_id).toBe(p.caravanId); // the instance is caravan-level
    expect(acquired[0]!.causation_id).toBe(spent[0]!.causation_id);
    expect((await verifyProjection(pool, p.accountId)).ok).toBe(true);
  });

  it("no cooldown, no daily limit: ten of the same type back to back, and six concurrent purchases, all succeed", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 16 * RECRUIT);
    for (let i = 0; i < 10; i++) {
      const r = await recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.dust_rider" });
      expect(r.replayed).toBe(false);
    }
    const race = await Promise.all(Array.from({ length: 6 }, () => recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.dust_rider", requestId: randomUUID() })));
    expect(race.every((r) => !r.replayed)).toBe(true);
    expect((await listUnitInstancesForCaravan(pool, p.caravanId)).filter((r) => r.unit_type_id === "desert.dust_rider")).toHaveLength(16);
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(0);
    expect(await spentEvents(p.accountId)).toHaveLength(16);
  });

  it("a retried purchase with the same requestId is charged once and yields one instance; reusing it for another type is refused", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 10 * RECRUIT);
    const requestId = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.dust_rider", requestId })));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.acquired.instanceId)).size).toBe(1);
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(9 * RECRUIT);
    const reused = await appErr(recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.well_digger", requestId }));
    expect(reused.code).toBe("request_id_reused");
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(9 * RECRUIT);
    const http = await call(p, "POST", `/me/caravans/${p.caravanId}/recruit`, { unitTypeId: "desert.dust_rider", requestId });
    expect(http.statusCode).toBe(200);
    expect(http.json().replayed).toBe(true);
  });

  it("insufficient Coin: refused with nothing written, and the view said so beforehand", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, RECRUIT - 1);
    const v = (await call(p, "GET", `/me/caravans/${p.caravanId}/recruit`)).json();
    expect(v.recruitable.every((r: { affordable: boolean }) => r.affordable === false)).toBe(true);
    const snap = await snapshot(p);
    const res = await call(p, "POST", `/me/caravans/${p.caravanId}/recruit`, { unitTypeId: "desert.dust_rider" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_coin");
    expect(await snapshot(p)).toBe(snap);
  });

  it("the trickle pending at purchase time counts: a balance shown as affordable is affordable", async () => {
    const p = await registerPlayer();
    await pool.query("UPDATE account SET created_at = now() - interval '2 days' WHERE id = $1", [p.accountId]);
    const t0 = await readTrickleAccrualPoint(pool, p.accountId);
    const nowMs = t0 + RECRUIT * TUNABLES.COIN_TRICKLE_MS_PER_COIN; // exactly the cost has trickled
    const v = await viewRecruit(pool, { ...owner(p), nowMs });
    expect(v.balance).toBe(RECRUIT);
    expect(v.pendingTrickle).toBe(RECRUIT);
    expect(v.recruitable[0]!.affordable).toBe(true);
    const r = await recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.dust_rider", nowMs });
    expect(r.balanceAfter).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("the unlock web is the only access gate (GUARDRAILS §3) — the central check", () => {
  const CASES: { label: string; typeId: string }[] = [
    { label: "a locked node of this region's web", typeId: DESERT_LOCKED_T1 },
    { label: "the capstone of this region's web", typeId: "desert.vaquero" },
    { label: "a starting node of ANOTHER region", typeId: "mountain.grizzly" },
    { label: "a locked node of another region", typeId: "mountain.blasting_crew" },
    { label: "a type that exists for nobody", typeId: "desert.ghost_rider" },
    { label: "a trap type under the unit paths", typeId: "trap.spike_pit" },
    { label: "an empty-looking id", typeId: " " },
  ];

  for (const { label, typeId } of CASES) {
    it(`recruit and claim both refuse ${label} by direct API call, writing nothing — with a full purse`, async () => {
      const p = await registerPlayer();
      await setBalance(p.accountId, TUNABLES.COIN_STORAGE_CAP);
      await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`);
      const snap = await snapshot(p);
      const recruit = await call(p, "POST", `/me/caravans/${p.caravanId}/recruit`, { unitTypeId: typeId });
      expect(recruit.statusCode, recruit.body).toBe(409);
      expect(recruit.json().error).toBe("not_unlocked");
      const claim = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: typeId, sequence: 1 });
      expect([400, 409]).toContain(claim.statusCode); // not_offered or not_unlocked: never an instance
      expect(await snapshot(p)).toBe(snap);
      expect((await readCoinBalance(pool, p.accountId)).balance).toBe(TUNABLES.COIN_STORAGE_CAP);
    });
  }

  it("exhaustive: with the storage cap in Coin, no living type outside the reached set can be produced by either path", async () => {
    const p = await registerPlayer("mountain");
    await setBalance(p.accountId, TUNABLES.COIN_STORAGE_CAP);
    await viewRefugees(pool, owner(p)); // menu 1 exists, so the claim reaches the gate rather than `no_menu`
    const reached = await reachedNodeIds(pool, "living", owner(p));
    const unreached = LIVING_UNIT_TYPES.map((u) => u.id).filter((id) => !reached.has(id));
    expect(unreached.length).toBe(LIVING_UNIT_TYPES.length - 2);
    for (const typeId of unreached) {
      const e1 = await appErr(recruitMercenary(pool, { ...owner(p), unitTypeId: typeId }));
      expect(e1.code, typeId).toBe("not_unlocked");
      const e2 = await appErr(claimRefugee(pool, { ...owner(p), unitTypeId: typeId, sequence: 1 }));
      expect(["not_offered", "not_unlocked"], typeId).toContain(e2.code);
    }
    const roster = await listUnitInstancesForCaravan(pool, p.caravanId);
    for (const r of roster) expect(reached.has(r.unit_type_id), r.unit_type_id).toBe(true);
    expect(await unitAcquiredEvents(p.accountId)).toHaveLength(0);
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(TUNABLES.COIN_STORAGE_CAP);
  });

  it("a menu row is not trusted as proof of access: a tampered offer of a locked type is still refused at the boundary", async () => {
    const p = await registerPlayer();
    await viewRefugees(pool, owner(p));
    // Simulate a corrupted / stale row (the owner role can write what the app never would).
    await pool.query("UPDATE refugee_menu SET offered_type_ids = $2::jsonb WHERE caravan_id = $1 AND sequence = 1", [
      p.caravanId,
      JSON.stringify([DESERT_LOCKED_T1, "desert.dust_rider", "desert.dust_rider"]),
    ]);
    const snap = await snapshot(p);
    const err = await appErr(claimRefugee(pool, { ...owner(p), unitTypeId: DESERT_LOCKED_T1, sequence: 1 }));
    expect(err.code).toBe("not_unlocked");
    expect(await snapshot(p)).toBe(snap);
    // And once the web reaches it, the same row claims fine: access came from the web, not the row.
    await grantLiving(p, 5);
    await unlock(p, DESERT_LOCKED_T1);
    const ok = await claimRefugee(pool, { ...owner(p), unitTypeId: DESERT_LOCKED_T1, sequence: 1 });
    expect(ok.acquired.unitTypeId).toBe(DESERT_LOCKED_T1);
  });

  it("reaching a node makes it recruitable at once — at the same price as everything else", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 2 * RECRUIT);
    await grantLiving(p, 5);
    await unlock(p, DESERT_LOCKED_T1);
    const v = await viewRecruit(pool, owner(p));
    expect(v.recruitable.map((r) => r.unitTypeId)).toEqual([...DESERT_STARTERS, DESERT_LOCKED_T1].sort());
    expect(new Set(v.recruitable.map((r) => r.cost)).size).toBe(1);
    const r = await recruitMercenary(pool, { ...owner(p), unitTypeId: DESERT_LOCKED_T1 });
    expect(r.instance).toMatchObject({ unit_type_id: DESERT_LOCKED_T1, merge_level: 1 });
  });

  it("source: every instance created by acquisition goes through grantUnit, which calls hasAccess; nothing else writes unit_acquired or reads billing state", () => {
    const dir = join(__dirname, "../src/acquisition");
    const files = readdirSync(dir).map((f) => join(dir, f));
    const inserts = files.filter((f) => /INSERT INTO unit_instance/i.test(readFileSync(f, "utf8")));
    expect(inserts.map((f) => f.split("/").pop())).toEqual(["grant.ts"]);
    const grant = readFileSync(join(dir, "grant.ts"), "utf8");
    const insertAt = grant.indexOf("INSERT INTO unit_instance");
    const accessAt = grant.indexOf("await hasAccess(");
    expect(accessAt).toBeGreaterThan(-1);
    expect(grant.indexOf("await assertUnlockedLivingType(client, owner, typeId)")).toBeLessThan(insertAt);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/entitle|billing|purchase_record|coin_purchased|\bpacks?\b|premium|subscription|stripe/i);
    }
    // The only writers of `unit_acquired` in src are acquisition/ (plus the vocabulary in ledger/events.ts)
    // and, since chunk 25 QA D3, the authored set's roster story — system accounts only, source
    // "authored_set", types reached through spendUnlockPoints first (authored.test.ts checks access).
    const srcRoot = join(__dirname, "../src");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const writers = walk(srcRoot).filter((f) => /type:\s*["']unit_acquired["']/.test(readFileSync(f, "utf8")));
    expect(writers.map((f) => f.replace(srcRoot, "")).sort()).toEqual(["/acquisition/grant.ts", "/matchmaking/authored.ts"]);
    const authored = readFileSync(join(srcRoot, "matchmaking/authored.ts"), "utf8");
    expect(authored.match(/type:\s*["']unit_acquired["'][^}]*\}/g)?.every((m) => /source: "authored_set"/.test(m))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("storage guard, ownership, split, and the on-trip caravan", () => {
  it("UNIT_INVENTORY_CAP refuses both paths at the cap, before any Coin moves; the cap is far above a full level-5 circle's needs", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 2_000);
    const have = (await listUnitInstancesForCaravan(pool, p.caravanId)).length;
    for (let i = have; i < CAP - 1; i++) await createUnitInstance(pool, { caravanId: p.caravanId, unitTypeId: "desert.dust_rider" });
    // One slot left: the mercenary takes it.
    const last = await recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.dust_rider" });
    expect(last.inventory).toMatchObject({ count: CAP, room: 0, full: true });
    const v = await viewRefugees(pool, owner(p));
    const snap = await snapshot(p);
    const full = await appErr(recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.dust_rider" }));
    expect(full.code).toBe("inventory_full");
    const claim = await appErr(claimRefugee(pool, { ...owner(p), unitTypeId: v.menu.offers[0]!.unitTypeId, sequence: v.menu.sequence }));
    expect(claim.code).toBe("inventory_full");
    expect(await snapshot(p)).toBe(snap);
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(2_000 - RECRUIT);
    // Never binds in practice: eight level-5 units built 2→1 consume 8 × 16 level-1 copies in total,
    // but at most 8 × 8 + a working margin are ever held at once.
    expect(CAP).toBeGreaterThanOrEqual(2 * 8 * 8);
  });

  it("another account's caravan is a 404 on every route (never confirmed to exist); a malformed id is a 400 before any query", async () => {
    const a = await registerPlayer();
    const b = await registerPlayer();
    await setBalance(b.accountId, 5_000);
    for (const [method, url, payload] of [
      ["GET", `/me/caravans/${a.caravanId}/refugees`, undefined],
      ["POST", `/me/caravans/${a.caravanId}/refugees/claim`, { unitTypeId: "desert.dust_rider", sequence: 1 }],
      ["POST", `/me/caravans/${a.caravanId}/refugees/refresh`, { fromSequence: 1 }],
      ["POST", `/me/caravans/${a.caravanId}/refugees/reroll`, { fromSequence: 1 }],
      ["GET", `/me/caravans/${a.caravanId}/recruit`, undefined],
      ["POST", `/me/caravans/${a.caravanId}/recruit`, { unitTypeId: "desert.dust_rider" }],
    ] as const) {
      const res = await call(b, method, url, payload);
      expect(res.statusCode, url).toBe(404);
    }
    expect((await listUnitInstancesForCaravan(pool, a.caravanId)).length).toBe(0);
    expect(await menuRows(a.caravanId)).toHaveLength(0);
    const bad = await call(b, "GET", "/me/caravans/not-a-uuid/recruit");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_caravan_id");
    const unauth = await app.inject({ method: "GET", url: `/me/caravans/${a.caravanId}/refugees` });
    expect(unauth.statusCode).toBe(401);
  });

  it("malformed bodies are 400s, not 500s", async () => {
    const p = await registerPlayer();
    for (const body of [null, [], { unitTypeId: 7 }, { unitTypeId: "" }, { unitTypeId: "a".repeat(101) }]) {
      const r = await call(p, "POST", `/me/caravans/${p.caravanId}/recruit`, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await call(p, "POST", `/me/caravans/${p.caravanId}/recruit`, { unitTypeId: "desert.dust_rider", requestId: "nope" })).json().error).toBe("invalid_request_id");
    expect((await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: "desert.dust_rider", sequence: 0 })).json().error).toBe("invalid_sequence");
    expect((await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/reroll`, { fromSequence: "1" })).json().error).toBe("invalid_fromSequence");
  });

  it("split: the instance and unit_acquired land on the caravan; the debit lands on the account with no caravan id", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, RECRUIT);
    const r = await recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.dust_rider" });
    expect(r.instance!.caravan_id).toBe(p.caravanId);
    const [debit, acquired] = r.events;
    expect(debit!.event_type).toBe("coin_spent");
    expect(debit!.caravan_id).toBeNull();
    expect(acquired!.event_type).toBe("unit_acquired");
    expect(acquired!.caravan_id).toBe(p.caravanId);
    const menus = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'refugee_menu'");
    expect(menus.rows.map((c: { column_name: string }) => c.column_name)).not.toContain("account_id");
  });

  it("a caravan on a trip may still acquire: the instance joins the town roster, not the trip (nothing is resupplied)", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, RECRUIT);
    await setCaravanState(pool, p.caravanId, "on_trip");
    const r = await recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.dust_rider" });
    expect(r.instance!.merge_level).toBe(1);
    const manifests = await pool.query("SELECT count(*)::int AS n FROM wagon_manifest WHERE caravan_id = $1", [p.caravanId]);
    expect(manifests.rows[0].n).toBe(0);
    await setCaravanState(pool, p.caravanId, "in_town");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("generous acquisition: rebuilding a wiped level-3 unit from zero (the walkthrough)", () => {
  it("documents the real Coin and hours — and proves the Coin path end to end", async () => {
    // A level-3 unit via 2→1 twice: 4 level-1 copies -> 2 level-2 -> 1 level-3.
    const copies = 4;
    const mergeCoin = 2 * mergeCost(2, 1) + mergeCost(3, 1); // 2 × 250 + 900
    const recruitCoin = copies * RECRUIT; // 4 × 600
    const allCoin = recruitCoin + mergeCoin;
    expect(mergeCoin).toBe(1_400);
    expect(recruitCoin).toBe(2_400);
    expect(allCoin).toBe(3_800);
    const trickleHours = allCoin / TUNABLES.COIN_TRICKLE_RATE_PER_HOUR; // idle only
    expect(trickleHours).toBe(19);
    // Free path: each free menu offers 3 distinct draws from a pool of n, so a given type is
    // offered with probability 3/n per menu (n >= 3) — every 90 minutes.
    const n = unitsForRegion("desert").length; // 8 with the whole web reached
    const expectedMenusPerCopy = n / TUNABLES.REFUGEE_OFFER_COUNT;
    const freeHours = (copies * expectedMenusPerCopy * TUNABLES.REFUGEE_REFRESH_INTERVAL_MINUTES) / 60;
    expect(freeHours).toBe(16); // plus 1 400 merge Coin = 7 h of trickle, overlapping
    // With only the 2 starters reached, the type is on EVERY menu: 4 menus = 6 h.
    expect((copies * TUNABLES.REFUGEE_REFRESH_INTERVAL_MINUTES) / 60).toBe(6);
    // One banked 5-encounter trip pays 3 782 (chunk 16): the whole rebuild is ~1 trip's Coin.

    // Prove the Coin path: 4 recruits, then two merges and one merge, ending at one level-3 unit.
    const p = await registerPlayer();
    await setBalance(p.accountId, allCoin);
    const ids: string[] = [];
    for (let i = 0; i < copies; i++) ids.push((await recruitMercenary(pool, { ...owner(p), unitTypeId: "desert.dust_rider" })).instance!.id);
    const merge = (instanceIds: string[]) => call(p, "POST", `/me/caravans/${p.caravanId}/merge`, { instanceIds });
    const l2a = (await merge([ids[0]!, ids[1]!])).json().producedInstanceIds[0] as string;
    const l2b = (await merge([ids[2]!, ids[3]!])).json().producedInstanceIds[0] as string;
    const l3 = await merge([l2a, l2b]);
    expect(l3.statusCode, l3.body).toBe(200);
    const roster = await listUnitInstancesForCaravan(pool, p.caravanId);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.merge_level).toBe(3);
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe("QA round 1 punch list (roadmap/qa/18-punchlist.md): the reviewer's probes as regressions", () => {
  const t0 = 1_800_000_000_000;

  it("D1/S2: a GET past the timer never writes — not a menu row, not a ledger event — however often it is polled", async () => {
    const p = await registerPlayer();
    await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    const before = await snapshot(p);
    for (const at of [t0 + INTERVAL, t0 + INTERVAL + 1, t0 + 3 * INTERVAL, t0 + 100 * INTERVAL]) {
      const v = await viewRefugees(pool, { ...owner(p), nowMs: at });
      expect(v.menu.sequence).toBe(1);
      expect(v.timer).toMatchObject({ freeRefreshDue: true, refreshedNow: false, msUntilFreeRefresh: 0 });
      const http = await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`);
      expect(http.statusCode).toBe(200);
    }
    expect(await snapshot(p)).toBe(before);
    expect(await menuRows(p.caravanId)).toHaveLength(1);
  });

  it("D2: the free timer is a fixed grid — taking every refresh 50 minutes late still yields 16 menus a day, each anchored to its grid point; one menu per take, never two", async () => {
    const p = await registerPlayer();
    const first = await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    expect(first.timer.windowOpenedAtMs).toBe(t0);
    const late = 50 * 60_000;
    let seq = 1;
    for (let k = 1; k <= 16; k++) {
      const at = t0 + k * INTERVAL + late;
      // One ms before the grid point: not due.
      if (k === 1) expect((await appErr(refreshRefugees(pool, { ...owner(p), fromSequence: seq, nowMs: t0 + INTERVAL - 1 }))).code).toBe("free_refresh_not_due");
      const r = await refreshRefugees(pool, { ...owner(p), fromSequence: seq, nowMs: at });
      expect(r.produced.sequence).toBe(seq + 1);
      expect(r.view.timer.windowOpenedAtMs).toBe(t0 + k * INTERVAL); // the grid point, not `at`
      expect(r.view.timer.nextFreeRefreshAtMs).toBe(t0 + (k + 1) * INTERVAL);
      expect(r.view.timer.msUntilFreeRefresh).toBe(INTERVAL - late);
      // Immediately again: nothing stockpiled.
      expect((await appErr(refreshRefugees(pool, { ...owner(p), fromSequence: seq + 1, nowMs: at }))).code).toBe("free_refresh_not_due");
      seq = r.produced.sequence;
    }
    // 16 refreshes in the 24 h after the anchor (the 16th was taken at 24 h 50 min; its window opened at 24 h).
    expect(seq).toBe(17);
    expect(await menuRows(p.caravanId)).toHaveLength(17);
    // Away for a week: ONE menu, on the grid, and the next window one interval after it.
    const week = t0 + 16 * INTERVAL + 7 * 24 * 3_600_000 + 12_345;
    const back = await refreshRefugees(pool, { ...owner(p), fromSequence: 17, nowMs: week });
    const k = Math.floor((week - t0) / INTERVAL);
    expect(back.view.timer.windowOpenedAtMs).toBe(t0 + k * INTERVAL);
    expect(back.view.timer.nextFreeRefreshAtMs).toBe(t0 + (k + 1) * INTERVAL);
    expect(await menuRows(p.caravanId)).toHaveLength(18);
    // Rerolls inherit the window's grid point and never move it.
    await setBalance(p.accountId, 1_000);
    const paid = await rerollRefugees(pool, { ...owner(p), fromSequence: 18, nowMs: week + 1 });
    expect(paid.view.timer.windowOpenedAtMs).toBe(t0 + k * INTERVAL);
    expect((await menuRows(p.caravanId)).at(-1)!.window_opened_at_ms).toBe(t0 + k * INTERVAL);
    for (const row of await menuRows(p.caravanId)) expect(replayMenu(row).ok).toBe(true);
  });

  it("S1: `fromSequence` is required — two concurrent `{}` rerolls are both 400s and charge nothing (the reviewer's double-tap)", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 2_000);
    await viewRefugees(pool, owner(p));
    const snap = await snapshot(p);
    const dbl = await Promise.all([
      call(p, "POST", `/me/caravans/${p.caravanId}/refugees/reroll`, {}),
      call(p, "POST", `/me/caravans/${p.caravanId}/refugees/reroll`, {}),
    ]);
    expect(dbl.map((r) => r.statusCode)).toEqual([400, 400]);
    expect(dbl.map((r) => r.json().error)).toEqual(["invalid_fromSequence", "invalid_fromSequence"]);
    expect(await snapshot(p)).toBe(snap);
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(2_000);
    // With it named, two concurrent rerolls of the same menu charge once (the second replays).
    const named = await Promise.all([
      call(p, "POST", `/me/caravans/${p.caravanId}/refugees/reroll`, { fromSequence: 1 }),
      call(p, "POST", `/me/caravans/${p.caravanId}/refugees/reroll`, { fromSequence: 1 }),
    ]);
    expect(named.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect((await readCoinBalance(pool, p.accountId)).balance).toBe(2_000 - 150);
    expect(await menuRows(p.caravanId)).toHaveLength(2);
    const refresh = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/refresh`, {});
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json().error).toBe("invalid_fromSequence");
  });

  it("S1: `sequence` is required on claim — a lost-response retry names its menu and replays across a free refresh (one instance), while an unnamed retry is a 400", async () => {
    const p = await registerPlayer();
    const v = await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    const pick = v.menu.offers[0]!.unitTypeId;
    const unnamed = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: pick });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json().error).toBe("invalid_sequence");
    expect(await unitAcquiredEvents(p.accountId)).toHaveLength(0);
    const c1 = await claimRefugee(pool, { ...owner(p), unitTypeId: pick, sequence: 1, nowMs: t0 + 10 });
    expect(c1.replayed).toBe(false);
    // The response was lost; the client retries after the timer rolled over (the reviewer's probe 3).
    const c2 = await claimRefugee(pool, { ...owner(p), unitTypeId: pick, sequence: 1, nowMs: t0 + INTERVAL + 10 });
    expect(c2.replayed).toBe(true);
    expect(c2.acquired.instanceId).toBe(c1.acquired.instanceId);
    expect((await listUnitInstancesForCaravan(pool, p.caravanId)).filter((r) => r.unit_type_id === pick)).toHaveLength(1);
    expect(await unitAcquiredEvents(p.accountId)).toHaveLength(1);
    // A replay generates nothing: the due refresh is still waiting to be taken.
    expect(await menuRows(p.caravanId)).toHaveLength(1);
    expect(c2.view.timer.freeRefreshDue).toBe(true);
  });

  it("S3: sequence fields are bounded to 1..2147483647 on every route — out of range, non-integer, or non-number is a 400, never a 500 or a query", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 5_000);
    await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`);
    const snap = await snapshot(p);
    const bad = [1e308, 9007199254740993, 2147483648, 0, -1, 1.5, "1", true, null, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of bad) {
      const claim = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: "desert.dust_rider", sequence: value });
      expect(claim.statusCode, `claim sequence=${String(value)}`).toBe(400);
      expect(claim.json().error).toBe("invalid_sequence");
      for (const route of ["reroll", "refresh"]) {
        const r = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/${route}`, { fromSequence: value });
        expect(r.statusCode, `${route} fromSequence=${String(value)}`).toBe(400);
        expect(r.json().error).toBe("invalid_fromSequence");
      }
    }
    // The bound itself is a valid value: it passes validation and reaches the menu check.
    const edge = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: "desert.dust_rider", sequence: 2147483647 });
    expect(edge.statusCode).toBe(409);
    expect(edge.json().error).toBe("menu_expired");
    const edgeReroll = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/reroll`, { fromSequence: 2147483647 });
    expect(edgeReroll.json().error).toBe("stale_menu");
    expect(await snapshot(p)).toBe(snap);
  });

  it("N2: a clock that goes backwards shows at most one interval until the next free menu, and writes nothing", async () => {
    const p = await registerPlayer();
    await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    const skewed = await viewRefugees(pool, { ...owner(p), nowMs: t0 - 5 * INTERVAL });
    expect(skewed.timer.msUntilFreeRefresh).toBe(INTERVAL);
    expect(skewed.timer.freeRefreshDue).toBe(false);
    expect(await menuRows(p.caravanId)).toHaveLength(1);
    // Forward again: the grid is untouched.
    const normal = await viewRefugees(pool, { ...owner(p), nowMs: t0 + INTERVAL / 2 });
    expect(normal.timer.msUntilFreeRefresh).toBe(INTERVAL / 2);
  });

  it("N3: a stored menu the module could not have written is a 409 `menu_corrupt` naming the caravan, not a 500; nothing is written around it", async () => {
    const p = await registerPlayer();
    await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    for (const offers of [["desert.dust_rider", "desert.nobody", "desert.dust_rider"], []]) {
      await pool.query("UPDATE refugee_menu SET offered_type_ids = $2::jsonb WHERE caravan_id = $1 AND sequence = 1", [p.caravanId, JSON.stringify(offers)]);
      const get = await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`);
      expect(get.statusCode, JSON.stringify(offers)).toBe(409);
      expect(get.json().error).toBe("menu_corrupt");
      expect(get.json().message).toContain(p.caravanId);
      const direct = await appErr(viewRefugees(pool, { ...owner(p), nowMs: t0 }));
      expect(direct).toBeInstanceOf(AppError);
      expect(direct.statusCode).toBe(409);
      // A refresh that would forfeit the corrupt menu is refused the same way, before it writes.
      const refresh = await appErr(refreshRefugees(pool, { ...owner(p), fromSequence: 1, nowMs: t0 + INTERVAL }));
      expect(refresh.code).toBe("menu_corrupt");
      expect(await menuRows(p.caravanId)).toHaveLength(1);
    }
  });

  it("N3: a reroll whose causation committed without its menu is `menu_corrupt`, not a bare Error", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 1_000);
    await viewRefugees(pool, { ...owner(p), nowMs: t0 });
    await rerollRefugees(pool, { ...owner(p), fromSequence: 1, nowMs: t0 + 1 });
    await pool.query("DELETE FROM refugee_menu WHERE caravan_id = $1 AND sequence = 2", [p.caravanId]);
    const err = await appErr(rerollRefugees(pool, { ...owner(p), fromSequence: 1, nowMs: t0 + 2 }));
    expect(err.code).toBe("menu_corrupt");
    expect(err.message).toContain(p.caravanId);
    expect(await spentEvents(p.accountId)).toHaveLength(1);
  });

  it("determinism golden (the reviewer's det.ts): 5 000 draws over an 8-type pool hash to a pinned value; every stored row in the suite replays", async () => {
    const eight = ["desert.dust_rider", "desert.well_digger", "desert.sand_sharpshooter", "desert.a", "desert.b", "desert.c", "desert.d", "desert.e"];
    const lines: string[] = [];
    for (let seq = 1; seq <= 5000; seq++) lines.push(JSON.stringify(drawForSequence("7b3c1b3e-1111-4222-8333-444455556666", seq, eight)));
    const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
    // Pinned on 2026-10-11. A change here is a change to what every caravan is offered: bump deliberately, never silently.
    expect(digest).toBe("c489d769a917c3af613efbd282ca7164c5532a123f9ba14e46912cbbc15ec152");
    const all = (await pool.query<RefugeeMenuRow>("SELECT * FROM refugee_menu")).rows;
    expect(all.length).toBeGreaterThan(50);
    const broken = all.filter((r) => !replayMenu(r).ok);
    // The only rows that fail to replay are the ones tests tampered with deliberately — and every one of
    // those offers something outside its own stored pool, which the module never writes.
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.every((r) => r.offered_type_ids.length === 0 || r.offered_type_ids.some((id) => !r.pool_type_ids.includes(id)))).toBe(true);
  });

  it("the reviewer's junk-request sweep: odd type ids and an upper-cased caravan id are 4xx or normalized, never 500s, and write nothing", async () => {
    const p = await registerPlayer();
    await setBalance(p.accountId, 5_000);
    await call(p, "GET", `/me/caravans/${p.caravanId}/refugees`);
    const snap = await snapshot(p);
    for (const typeId of ["DESERT.DUST_RIDER", "desert.dust_rider ", "desert.dust_rider\u0000", "mountain.dust_rider", "x".repeat(100)]) {
      const recruit = await call(p, "POST", `/me/caravans/${p.caravanId}/recruit`, { unitTypeId: typeId });
      expect(recruit.statusCode, JSON.stringify(typeId)).toBe(409);
      expect(recruit.json().error).toBe("not_unlocked");
      const claim = await call(p, "POST", `/me/caravans/${p.caravanId}/refugees/claim`, { unitTypeId: typeId, sequence: 1 });
      expect([400, 409], JSON.stringify(typeId)).toContain(claim.statusCode);
    }
    for (const body of ["not json", '"str"', "[1, 2]"]) {
      const r = await app.inject({ method: "POST", url: `/me/caravans/${p.caravanId}/refugees/claim`, headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" }, payload: body });
      expect(r.statusCode, body).toBe(400);
    }
    expect(await snapshot(p)).toBe(snap);
    const upper = await call(p, "GET", `/me/caravans/${p.caravanId.toUpperCase()}/recruit`);
    expect(upper.statusCode).toBe(200);
    expect((await call(p, "GET", `/me/caravans/00000000-0000-0000-0000-000000000000/refugees`)).statusCode).toBe(404);
  });
});
