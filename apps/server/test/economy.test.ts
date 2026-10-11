/**
 * Chunk 16 against the database: every credit path clamps to the cap, the trickle is
 * materialized exactly once per accrual window however often it's read, merges are atomic
 * and charged exactly once under a race, and the ledger alone reproduces the balance.
 */
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { issueSession } from "../src/auth/sessions.js";
import { withTransaction } from "../src/db/pool.js";
import { appendCoinCredits, coinForBankedTrip, creditBankedTrip, creditPartyWin, readCoinBalance } from "../src/economy/coin.js";
import { mergeCost, performMerge, previewMerge } from "../src/economy/merge.js";
import { accrueTrickle, readTrickleAccrualPoint } from "../src/economy/trickle.js";
import { coinDebitDraft } from "../src/ledger/coin.js";
import { appendEvents, listEventsForAccount } from "../src/ledger/ledger.js";
import { verifyProjection } from "../src/ledger/projection.js";
import { createUnitInstance, listUnitInstancesForCaravan } from "../src/repo/unitInstances.js";
import { AppError } from "../src/services/errors.js";
import { registerAccount } from "../src/services/onboarding.js";
import { testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
let app: FastifyInstance;
const MS = TUNABLES.COIN_TRICKLE_MS_PER_COIN;
const CAP = TUNABLES.COIN_STORAGE_CAP;
const UNIT = "desert.dust_rider";

async function fresh(prefix: string) {
  const { account, caravan } = await registerAccount(pool, { username: unique(prefix), password: "password123", regionId: "desert" });
  return { accountId: account.id, caravanId: caravan.id };
}

/** Set a balance by writing earn/spend events (the only way to move it). */
async function setBalance(accountId: string, target: number) {
  const { balance } = await readCoinBalance(pool, accountId);
  const tag = unique("set");
  await withTransaction(pool, async (c) => {
    if (target > balance) await appendCoinCredits(c, { causationId: `test:${tag}`, accountId, credits: [{ amount: target - balance, reason: "test_setup" }] });
    else if (target < balance) await appendEvents(c, `test:${tag}`, [coinDebitDraft({ accountId, amount: balance - target, reason: "test_setup" })]);
  });
}

async function units(caravanId: string, level: number, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await createUnitInstance(pool, { caravanId, unitTypeId: UNIT, mergeLevel: level })).id);
  return ids;
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

beforeAll(async () => {
  await truncateAll(pool);
  app = await buildApp({ db: pool });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("no credit path passes the cap", () => {
  it("a banked trip near the cap credits only the room and records the rest as discarded, per event", async () => {
    const { accountId } = await fresh("bank");
    await setBalance(accountId, CAP - 1000);
    const res = await withTransaction(pool, (c) => creditBankedTrip(c, { accountId, causationId: "trip:t1:bank", tripId: "t1", encountersSurvived: 3 }));
    expect(res.credited).toBe(1000);
    expect(res.discarded).toBe(coinForBankedTrip(3) - 1000);
    expect(res.balanceAfter).toBe(CAP);
    expect(res.rows.map((r) => r.payload["amount"])).toEqual([400, 500, 100, 0]);
    expect(res.rows.map((r) => r.payload["overflowDiscarded"] ?? 0)).toEqual([0, 0, 525, 500]);
    expect(res.rows.map((r) => r.payload["reason"])).toEqual(["encounter_survived", "encounter_survived", "encounter_survived", "trip_banked"]);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(CAP);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("a party win at the cap credits zero and says so; below the cap it credits COIN_PER_PARTY_WIN once", async () => {
    const { accountId } = await fresh("party");
    await setBalance(accountId, CAP);
    const atCap = await withTransaction(pool, (c) => creditPartyWin(c, { accountId, causationId: "job:e1", tripId: "t9", encounterIndex: 2 }));
    expect(atCap.credited).toBe(0);
    expect(atCap.discarded).toBe(TUNABLES.COIN_PER_PARTY_WIN);
    await setBalance(accountId, 10);
    const below = await withTransaction(pool, (c) => creditPartyWin(c, { accountId, causationId: "job:e2", tripId: "t9", encounterIndex: 3 }));
    expect(below.balanceAfter).toBe(10 + TUNABLES.COIN_PER_PARTY_WIN);
    // The same cause can never credit twice.
    await expect(
      withTransaction(pool, (c) => creditPartyWin(c, { accountId, causationId: "job:e2", tripId: "t9", encounterIndex: 3 })),
    ).rejects.toMatchObject({ code: "23505" });
    expect((await readCoinBalance(pool, accountId)).balance).toBe(10 + TUNABLES.COIN_PER_PARTY_WIN);
  });

  it("concurrent credits from many writers never overshoot the cap", async () => {
    const { accountId } = await fresh("race");
    await setBalance(accountId, CAP - 2500);
    const writers = Array.from({ length: 12 }, (_, i) =>
      withTransaction(pool, (c) => appendCoinCredits(c, { causationId: `race:${i}`, accountId, credits: [{ amount: 400, reason: "race" }] })),
    );
    const results = await Promise.all(writers);
    const credited = results.reduce((a, r) => a + r.credited, 0);
    const discarded = results.reduce((a, r) => a + r.discarded, 0);
    expect(credited).toBe(2500);
    expect(discarded).toBe(12 * 400 - 2500);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(CAP);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("the database refuses a direct overshoot even if application code is bypassed", async () => {
    const { accountId } = await fresh("direct");
    await setBalance(accountId, CAP);
    await expect(
      withTransaction(pool, (c) => appendEvents(c, "test:direct-overshoot", [{ type: "coin_earned", accountId, payload: { amount: 1, reason: "x" } }])),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the lazy trickle", () => {
  it("starts at account creation, credits whole coins, and is written as a ledger event", async () => {
    const { accountId } = await fresh("trk");
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const r = await accrueTrickle(pool, accountId, t0 + 5 * MS + 123);
    expect(r).toMatchObject({ coins: 5, credited: 5, discarded: 0, balance: 5, accruedThroughMs: t0 + 5 * MS, nextCoinInMs: MS - 123 });
    const evs = await listEventsForAccount(pool, accountId);
    expect(evs.length).toBe(1);
    expect(evs[0]!.payload).toMatchObject({ reason: "trickle", amount: 5, coins: 5, accruedFromMs: t0, accruedThroughMs: t0 + 5 * MS });
    expect(evs[0]!.causation_id).toBe(`trickle:${accountId}:${t0}`);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("is idempotent across repeated reads: 60 reads over an hour == one read at the hour", async () => {
    const a = await fresh("many");
    const b = await fresh("once");
    const ta = await readTrickleAccrualPoint(pool, a.accountId);
    const tb = await readTrickleAccrualPoint(pool, b.accountId);
    for (let i = 1; i <= 60; i++) await accrueTrickle(pool, a.accountId, ta + i * 60_000 + (i % 7) * 1000);
    await accrueTrickle(pool, a.accountId, ta + 3_600_000);
    await accrueTrickle(pool, b.accountId, tb + 3_600_000);
    expect((await readCoinBalance(pool, a.accountId)).balance).toBe(TUNABLES.COIN_TRICKLE_RATE_PER_HOUR);
    expect((await readCoinBalance(pool, b.accountId)).balance).toBe(TUNABLES.COIN_TRICKLE_RATE_PER_HOUR);
    // Reading the same instant twice writes nothing the second time.
    const before = (await listEventsForAccount(pool, a.accountId)).length;
    const again = await accrueTrickle(pool, a.accountId, ta + 3_600_000);
    expect(again.coins).toBe(0);
    expect((await listEventsForAccount(pool, a.accountId)).length).toBe(before);
  });

  it("concurrent reads of the same window credit it exactly once", async () => {
    const { accountId } = await fresh("ctrk");
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const results = await Promise.all(Array.from({ length: 8 }, () => accrueTrickle(pool, accountId, t0 + 10 * MS)));
    expect(results.reduce((s, r) => s + r.credited, 0)).toBe(10);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(10);
    expect((await listEventsForAccount(pool, accountId)).filter((e) => e.payload["reason"] === "trickle").length).toBe(1);
  });

  it("ceases at the cap and never credits past it, then resumes from the last read after a spend", async () => {
    const { accountId } = await fresh("cap");
    await setBalance(accountId, CAP - 3);
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const r = await accrueTrickle(pool, accountId, t0 + 100 * MS);
    expect(r).toMatchObject({ coins: 100, credited: 3, discarded: 97, balance: CAP, atCap: true, accruedThroughMs: t0 + 100 * MS });
    const r2 = await accrueTrickle(pool, accountId, t0 + 200 * MS);
    expect(r2).toMatchObject({ coins: 100, credited: 0, discarded: 100, balance: CAP });
    // A long idle at the cap banks no backlog.
    await setBalance(accountId, 1000);
    const r3 = await accrueTrickle(pool, accountId, t0 + 203 * MS);
    expect(r3).toMatchObject({ coins: 3, credited: 3, balance: 1003 });
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("GET /me/economy materializes the trickle and reports the overflow forecast", async () => {
    const { accountId } = await fresh("route");
    const { token } = await issueSession(pool, accountId);
    const res = await app.inject({ method: "GET", url: "/me/economy?prospectiveEarn=60000", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cap).toBe(CAP);
    expect(body.overflow).toMatchObject({ behavior: "discard_with_warning", prospectiveEarn: 60_000, warn: true });
    expect(body.overflow.wouldDiscard).toBe(60_000 - (CAP - body.balance));
    expect(body.merge.costPerResultingUnitByLevel).toEqual({ "2": 250, "3": 900, "4": 3000, "5": 9500 });
    expect(body.earn.encounterSchedule.slice(0, 3)).toEqual([400, 500, 625]);
    expect(body.merge.levelCap).toBe(5);
    const bad = await app.inject({ method: "GET", url: "/me/economy?prospectiveEarn=-1", headers: { authorization: `Bearer ${token}` } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/me/economy" })).statusCode).toBe(401);
  });
});

describe("merging", () => {
  it("2→1: consumes two, produces one at the next level, charges the target-level cost, writes both events", async () => {
    const { accountId, caravanId } = await fresh("m21");
    await setBalance(accountId, 1000);
    const ids = await units(caravanId, 1, 2);
    const preview = await previewMerge(pool, { accountId, caravanId, instanceIds: ids });
    expect(preview).toMatchObject({ fromLevel: 1, toLevel: 2, costPerUnit: 250, totalCost: 250, affordable: true, slotsFreed: 1 });
    expect(preview.consumed.slots).toBe(2);
    expect(preview.produced.slots).toBe(1);
    expect(preview.produced.perUnit.hp).toBeGreaterThan(preview.consumed.perUnit.hp);
    expect(preview.produced.combined.hp).toBeLessThan(preview.consumed.combined.hp);
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const result = await performMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 });
    expect(result.produced.length).toBe(1);
    expect(result.produced[0]).toMatchObject({ unit_type_id: UNIT, merge_level: 2, caravan_id: caravanId });
    expect(result.balanceAfter).toBe(750);
    const roster = await listUnitInstancesForCaravan(pool, caravanId);
    expect(roster.map((r) => r.id)).toEqual([result.produced[0]!.id]);
    const evs = await listEventsForAccount(pool, accountId);
    const spent = evs.find((e) => e.event_type === "coin_spent")!;
    const merged = evs.find((e) => e.event_type === "unit_merged")!;
    expect(spent.payload).toMatchObject({ amount: 250, reason: "merge", toLevel: 2 });
    expect(spent.caravan_id).toBeNull(); // Coin is account-level
    expect(merged.caravan_id).toBe(caravanId); // the roster is caravan-level
    expect(merged.payload).toMatchObject({ fromLevel: 1, toLevel: 2, recipe: { spend: 2, produce: 1 }, coinCost: 250, consumedInstanceIds: [...ids].sort() });
    expect(spent.causation_id).toBe(merged.causation_id);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(750);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("5→3: consumes five, produces three, charges three times the per-unit cost", async () => {
    const { accountId, caravanId } = await fresh("m53");
    await setBalance(accountId, 3000);
    const ids = await units(caravanId, 2, 5);
    const preview = await previewMerge(pool, { accountId, caravanId, instanceIds: ids });
    expect(preview).toMatchObject({ fromLevel: 2, toLevel: 3, costPerUnit: 900, totalCost: 2700, slotsFreed: 2, recipe: { spend: 5, produce: 3 } });
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const result = await performMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 });
    expect(result.produced.map((p) => p.merge_level)).toEqual([3, 3, 3]);
    expect((await listUnitInstancesForCaravan(pool, caravanId)).length).toBe(3);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(300);
  });

  it("the merge cost is charged exactly once when two merges of the same instances race", async () => {
    const { accountId, caravanId } = await fresh("mrace");
    await setBalance(accountId, 10_000);
    const ids = await units(caravanId, 3, 2);
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => performMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 })),
    );
    const ok = outcomes.filter((o) => o.status === "fulfilled");
    const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(5);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(AppError);
      expect((f.reason as AppError).statusCode).toBe(404); // inputs gone
    }
    expect((await readCoinBalance(pool, accountId)).balance).toBe(10_000 - mergeCost(4, 1));
    const roster = await listUnitInstancesForCaravan(pool, caravanId);
    expect(roster.length).toBe(1);
    expect(roster[0]!.merge_level).toBe(4);
    const evs = await listEventsForAccount(pool, accountId);
    expect(evs.filter((e) => e.event_type === "coin_spent").length).toBe(1);
    expect(evs.filter((e) => e.event_type === "unit_merged").length).toBe(1);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("insufficient Coin fails atomically: no units consumed, no events written", async () => {
    const { accountId, caravanId } = await fresh("poor");
    await setBalance(accountId, 249);
    const ids = await units(caravanId, 1, 2);
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const err = await appErr(performMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 }));
    expect(err.code).toBe("insufficient_coin");
    expect(err.statusCode).toBe(409);
    expect((await listUnitInstancesForCaravan(pool, caravanId)).map((r) => r.id).sort()).toEqual([...ids].sort());
    expect((await listEventsForAccount(pool, accountId)).filter((e) => e.event_type !== "coin_earned").length).toBe(0);
    const preview = await previewMerge(pool, { accountId, caravanId, instanceIds: ids });
    expect(preview.affordable).toBe(false);
  });

  it("the trickle accrued at merge time can make a merge affordable (balance checked is the balance shown)", async () => {
    const { accountId, caravanId } = await fresh("trmerge");
    await setBalance(accountId, 240);
    const ids = await units(caravanId, 1, 2);
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const result = await performMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 + 10 * MS });
    expect(result.balanceAfter).toBe(0);
  });

  it("rejects mixed types, mixed levels, wrong counts, duplicates, and the level cap", async () => {
    const { accountId, caravanId } = await fresh("bad");
    await setBalance(accountId, 40_000);
    const [a, b] = await units(caravanId, 1, 2);
    const other = (await createUnitInstance(pool, { caravanId, unitTypeId: "desert.well_digger", mergeLevel: 1 })).id;
    const [c] = await units(caravanId, 2, 1);
    const l5 = await units(caravanId, 5, 2);
    expect((await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: [a, other] }))).code).toBe("mixed_unit_types");
    expect((await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: [a, c] }))).code).toBe("mixed_merge_levels");
    expect((await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: [a, b, c] }))).code).toBe("no_such_recipe");
    expect((await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: [a] }))).code).toBe("no_such_recipe");
    expect((await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: [a, a] }))).code).toBe("duplicate_instances");
    expect((await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: l5 }))).code).toBe("merge_cap");
    expect((await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: "nope" }))).code).toBe("invalid_instance_ids");
    expect((await appErr(performMerge(pool, { accountId, caravanId, instanceIds: l5 }))).code).toBe("merge_cap");
    expect((await listUnitInstancesForCaravan(pool, caravanId)).length).toBe(6);
  });

  it("refuses instances that belong to another caravan or account, and a caravan that is not yours", async () => {
    const mine = await fresh("owner");
    const theirs = await fresh("thief");
    await setBalance(theirs.accountId, 40_000);
    const mineIds = await units(mine.caravanId, 1, 2);
    const wrongCaravan = await appErr(previewMerge(pool, { accountId: theirs.accountId, caravanId: mine.caravanId, instanceIds: mineIds }));
    expect(wrongCaravan.statusCode).toBe(404);
    const wrongUnits = await appErr(performMerge(pool, { accountId: theirs.accountId, caravanId: theirs.caravanId, instanceIds: mineIds }));
    expect(wrongUnits.statusCode).toBe(404);
    expect((await listUnitInstancesForCaravan(pool, mine.caravanId)).length).toBe(2);
    expect((await readCoinBalance(pool, theirs.accountId)).balance).toBe(40_000);
  });

  it("the HTTP merge flow: preview shows cost and stats, commit charges it", async () => {
    const { accountId, caravanId } = await fresh("http");
    await setBalance(accountId, 1000);
    const ids = await units(caravanId, 1, 2);
    const { token } = await issueSession(pool, accountId);
    const headers = { authorization: `Bearer ${token}` };
    const pv = await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge/preview`, headers, payload: { instanceIds: ids } });
    expect(pv.statusCode).toBe(200);
    expect(pv.json()).toMatchObject({ totalCost: 250, toLevel: 2, affordable: true, ability: { archetype: "dash" } });
    const roster = await listUnitInstancesForCaravan(pool, caravanId);
    expect(roster.length).toBe(2);
    const commit = await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge`, headers, payload: { instanceIds: ids } });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().produced[0].merge_level).toBe(2);
    expect(commit.json().events.map((e: { type: string }) => e.type)).toEqual(["coin_spent", "unit_merged"]);
    const again = await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge`, headers, payload: { instanceIds: ids } });
    expect(again.statusCode).toBe(404);
    const noBody = await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge`, headers, payload: {} });
    expect(noBody.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge`, payload: { instanceIds: ids } })).statusCode).toBe(401);
  });
});
