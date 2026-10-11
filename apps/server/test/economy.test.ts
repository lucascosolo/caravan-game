/**
 * Chunk 16 against the database: every credit path clamps to the cap, the trickle is
 * computed on every read but materialized only once enough has accrued (and never at the
 * cap), merges are atomic, charged exactly once under a race and replayed on retry, and
 * the ledger alone reproduces the balance. The last block is the QA round 1 punch list
 * (roadmap/qa/16-punchlist.md), one regression per item.
 */
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { issueSession } from "../src/auth/sessions.js";
import { withTransaction } from "../src/db/pool.js";
import { appendCoinCredits, coinForBankedTrip, creditBankedTrip, creditPartyWin, readCoinBalance, spendCoin } from "../src/economy/coin.js";
import { mergeCost, performMerge, previewMerge } from "../src/economy/merge.js";
import { accrueTrickle, peekTrickle, readTrickleAccrualPoint } from "../src/economy/trickle.js";
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
const MIN_COINS = TUNABLES.TRICKLE_MATERIALIZE_MIN_COINS;
const UNIT = "desert.dust_rider";

async function fresh(prefix: string) {
  const { account, caravan } = await registerAccount(pool, { username: unique(prefix), password: "password123", regionId: "desert" });
  return { accountId: account.id, caravanId: caravan.id };
}

/**
 * An account created `hoursAgo` in the past, so a test can drive the injectable clock
 * forward from creation and still have every injected instant lie BEFORE the database
 * clock that stamps `occurred_at` on a spend (the trickle's accrual point reads both).
 */
async function freshBackdated(prefix: string, hoursAgo: number) {
  const made = await fresh(prefix);
  await pool.query("UPDATE account SET created_at = now() - make_interval(hours => $2) WHERE id = $1", [made.accountId, hoursAgo]);
  return { ...made, t0: await readTrickleAccrualPoint(pool, made.accountId) };
}

/** Set a balance by writing earn/spend events (the only way to move it). Spends go through `spendCoin`. */
async function setBalance(accountId: string, target: number, nowMs?: number) {
  const { balance } = await readCoinBalance(pool, accountId);
  const tag = unique("set");
  await withTransaction(pool, async (c) => {
    if (target > balance) await appendCoinCredits(c, { causationId: `test:${tag}`, accountId, credits: [{ amount: target - balance, reason: "test_setup" }] });
    else if (target < balance) await spendCoin(c, accountId, balance - target, "test_setup", nowMs ?? (await readTrickleAccrualPoint(pool, accountId)), { causationId: `test:${tag}` });
  });
}

async function units(caravanId: string, level: number, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await createUnitInstance(pool, { caravanId, unitTypeId: UNIT, mergeLevel: level })).id);
  return ids;
}

async function trickleEvents(accountId: string) {
  return (await listEventsForAccount(pool, accountId, { limit: 500 })).filter((e) => e.payload["reason"] === "trickle");
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
    expect(res.rows.map((r) => r.payload["amount"])).toEqual([400, 539, 61, 0]);
    expect(res.rows.map((r) => r.payload["overflowDiscarded"] ?? 0)).toEqual([0, 0, 666, 375]);
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
  it("starts at account creation; below the threshold it is shown but not written, at the threshold it is written once", async () => {
    const { accountId } = await fresh("trk");
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const shown = await accrueTrickle(pool, accountId, t0 + 5 * MS + 123);
    expect(shown).toMatchObject({ coins: 5, credited: 5, pending: 5, ledgerBalance: 0, balance: 5, materialized: false, nextCoinInMs: MS - 123 });
    expect(await trickleEvents(accountId)).toEqual([]);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(0);
    const written = await accrueTrickle(pool, accountId, t0 + MIN_COINS * MS + 7);
    expect(written).toMatchObject({ coins: MIN_COINS, credited: MIN_COINS, pending: 0, ledgerBalance: MIN_COINS, balance: MIN_COINS, materialized: true, accruedThroughMs: t0 + MIN_COINS * MS });
    const evs = await trickleEvents(accountId);
    expect(evs.length).toBe(1);
    expect(evs[0]!.payload).toMatchObject({ reason: "trickle", amount: MIN_COINS, coins: MIN_COINS, accruedFromMs: t0, accruedThroughMs: t0 + MIN_COINS * MS });
    expect(evs[0]!.causation_id).toBe(`trickle:${accountId}:${t0}`);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("is idempotent across repeated reads: 60 reads over an hour == one read at the hour", async () => {
    const a = await fresh("many");
    const b = await fresh("once");
    const ta = await readTrickleAccrualPoint(pool, a.accountId);
    const tb = await readTrickleAccrualPoint(pool, b.accountId);
    for (let i = 1; i <= 60; i++) await accrueTrickle(pool, a.accountId, ta + i * 60_000 + (i % 7) * 1000);
    const lastA = await accrueTrickle(pool, a.accountId, ta + 3_600_000);
    const lastB = await accrueTrickle(pool, b.accountId, tb + 3_600_000);
    expect(lastA.balance).toBe(TUNABLES.COIN_TRICKLE_RATE_PER_HOUR);
    expect(lastB.balance).toBe(TUNABLES.COIN_TRICKLE_RATE_PER_HOUR);
    // What is shown is always ledger + pending, and the ledger never over-credits.
    expect(lastA.ledgerBalance + lastA.pending).toBe(TUNABLES.COIN_TRICKLE_RATE_PER_HOUR);
    expect((await readCoinBalance(pool, a.accountId)).balance).toBe(lastA.ledgerBalance);
    // Reading the same instant twice changes nothing.
    const before = (await listEventsForAccount(pool, a.accountId)).length;
    const again = await accrueTrickle(pool, a.accountId, ta + 3_600_000);
    expect(again.balance).toBe(lastA.balance);
    expect(again.materialized).toBe(false);
    expect((await listEventsForAccount(pool, a.accountId)).length).toBe(before);
  });

  it("concurrent reads of the same window credit it exactly once", async () => {
    const { accountId } = await fresh("ctrk");
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const results = await Promise.all(Array.from({ length: 8 }, () => accrueTrickle(pool, accountId, t0 + 10 * MS)));
    expect(results.filter((r) => r.materialized).length).toBe(1);
    for (const r of results) expect(r.balance).toBe(10);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(10);
    expect((await trickleEvents(accountId)).length).toBe(1);
  });

  it("ceases at the cap, writes nothing there, and a spend restarts it from the spend — no backlog", async () => {
    const { accountId, t0 } = await freshBackdated("cap", 3);
    await setBalance(accountId, CAP - 3);
    const r = await accrueTrickle(pool, accountId, t0 + 100 * MS);
    expect(r).toMatchObject({ coins: 100, credited: 3, discarded: 97, balance: CAP, atCap: true, materialized: true, accruedThroughMs: t0 + 100 * MS });
    const r2 = await accrueTrickle(pool, accountId, t0 + 200 * MS);
    expect(r2).toMatchObject({ coins: 100, credited: 0, discarded: 100, pending: 0, balance: CAP, materialized: false });
    expect((await trickleEvents(accountId)).length).toBe(1); // nothing written at the cap
    // Spend (occurred_at = database now, hours after t0 + 200 × MS). The accrual point is now the spend.
    await setBalance(accountId, 1000, t0 + 200 * MS);
    const spentAt = await readTrickleAccrualPoint(pool, accountId);
    expect(spentAt).toBeGreaterThan(t0 + 200 * MS);
    const r3 = await accrueTrickle(pool, accountId, spentAt + 3 * MS);
    expect(r3).toMatchObject({ coins: 3, credited: 3, balance: 1003, pending: 3 });
    const r4 = await accrueTrickle(pool, accountId, spentAt + 25 * MS);
    expect(r4).toMatchObject({ coins: 25, credited: 25, balance: 1025, materialized: true });
    expect((await trickleEvents(accountId)).every((e) => (e.payload["amount"] as number) > 0)).toBe(true);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("GET /me/economy reports ledger + pending as the balance and the overflow forecast", async () => {
    const { accountId } = await fresh("route");
    const { token } = await issueSession(pool, accountId);
    const res = await app.inject({ method: "GET", url: "/me/economy?prospectiveEarn=60000", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cap).toBe(CAP);
    expect(body.balance).toBe(body.trickle.ledgerBalance + body.trickle.pending);
    expect(body.overflow).toMatchObject({ behavior: "discard_with_warning", prospectiveEarn: 60_000, warn: true });
    expect(body.overflow.wouldDiscard).toBe(60_000 - (CAP - body.balance));
    expect(body.overflow.message).toContain("right now");
    expect(body.merge.costPerResultingUnitByLevel).toEqual({ "2": 250, "3": 900, "4": 3000, "5": 9500 });
    expect(body.earn.encounterSchedule.slice(0, 3)).toEqual([400, 539, 727]);
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
    expect(result.replayed).toBe(false);
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
    expect(spent.causation_seq).toBe(0);
    expect(merged.causation_seq).toBe(1);
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

  it("the merge cost is charged exactly once when six merges of the same instances race; the losers replay the winner", async () => {
    const { accountId, caravanId } = await fresh("mrace");
    await setBalance(accountId, 10_000);
    const ids = await units(caravanId, 3, 2);
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => performMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 })),
    );
    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
    const results = outcomes.map((o) => (o as PromiseFulfilledResult<Awaited<ReturnType<typeof performMerge>>>).value);
    const winners = results.filter((r) => !r.replayed);
    const replays = results.filter((r) => r.replayed);
    expect(winners.length).toBe(1);
    expect(replays.length).toBe(5);
    for (const r of replays) {
      expect(r.merged).toEqual(winners[0]!.merged);
      expect(r.preview).toBeNull();
      expect(r.producedIds).toEqual(winners[0]!.producedIds);
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
    const preview = await previewMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 });
    expect(preview.affordable).toBe(false);
  });

  it("the trickle accrued at merge time can make a merge affordable (balance checked is the balance shown)", async () => {
    const { accountId, caravanId } = await fresh("trmerge");
    await setBalance(accountId, 240);
    const ids = await units(caravanId, 1, 2);
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const result = await performMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 + 10 * MS });
    expect(result.balanceAfter).toBe(0);
    expect(result.preview!.balance).toBe(250);
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

  it("refuses instances that belong to another caravan or account, and a caravan that is not yours (404, the convention)", async () => {
    const mine = await fresh("owner");
    const theirs = await fresh("thief");
    await setBalance(theirs.accountId, 40_000);
    const mineIds = await units(mine.caravanId, 1, 2);
    const wrongCaravan = await appErr(previewMerge(pool, { accountId: theirs.accountId, caravanId: mine.caravanId, instanceIds: mineIds }));
    expect(wrongCaravan.statusCode).toBe(404);
    const wrongUnits = await appErr(performMerge(pool, { accountId: theirs.accountId, caravanId: theirs.caravanId, instanceIds: mineIds }));
    expect(wrongUnits.statusCode).toBe(404);
    // Four of mine plus one of theirs is refused whole; theirs is untouched.
    const theirIds = await units(theirs.caravanId, 1, 4);
    const mixed = await appErr(performMerge(pool, { accountId: theirs.accountId, caravanId: theirs.caravanId, instanceIds: [...theirIds, mineIds[0]!] }));
    expect(mixed.statusCode).toBe(404);
    expect((await listUnitInstancesForCaravan(pool, mine.caravanId)).length).toBe(2);
    expect((await listUnitInstancesForCaravan(pool, theirs.caravanId)).length).toBe(4);
    expect((await readCoinBalance(pool, theirs.accountId)).balance).toBe(40_000);
  });

  it("the HTTP merge flow: preview shows cost and stats, commit charges it, a retry replays it", async () => {
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
    expect(commit.json().replayed).toBe(false);
    expect(commit.json().produced[0].merge_level).toBe(2);
    expect(commit.json().events.map((e: { type: string }) => e.type)).toEqual(["coin_spent", "unit_merged"]);
    const again = await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge`, headers, payload: { instanceIds: ids } });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(again.json().merged).toEqual(commit.json().merged);
    expect(again.json().producedInstanceIds).toEqual(commit.json().producedInstanceIds);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(750);
    const noBody = await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge`, headers, payload: {} });
    expect(noBody.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge`, payload: { instanceIds: ids } })).statusCode).toBe(401);
  });
});

describe("QA round 1 punch list (roadmap/qa/16-punchlist.md)", () => {
  it("S1: a caravan on a trip cannot merge — preview and commit both 409 caravan_on_trip, roster untouched", async () => {
    const { accountId, caravanId } = await fresh("s1");
    await setBalance(accountId, 5000);
    const ids = await units(caravanId, 1, 2);
    await pool.query("UPDATE caravan SET state = 'on_trip' WHERE id = $1", [caravanId]);
    const pv = await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: ids }));
    expect(pv).toMatchObject({ statusCode: 409, code: "caravan_on_trip" });
    const cm = await appErr(performMerge(pool, { accountId, caravanId, instanceIds: ids }));
    expect(cm).toMatchObject({ statusCode: 409, code: "caravan_on_trip" });
    const { token } = await issueSession(pool, accountId);
    const http = await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge`, headers: { authorization: `Bearer ${token}` }, payload: { instanceIds: ids } });
    expect(http.statusCode).toBe(409);
    expect((await listUnitInstancesForCaravan(pool, caravanId)).map((r) => r.id).sort()).toEqual([...ids].sort());
    expect((await readCoinBalance(pool, accountId)).balance).toBe(5000);
    await pool.query("UPDATE caravan SET state = 'in_town' WHERE id = $1", [caravanId]);
    expect((await performMerge(pool, { accountId, caravanId, instanceIds: ids })).produced.length).toBe(1);
  });

  it("S2: the preview's balance includes the pending trickle, is read-only, and is what the commit checks", async () => {
    const { accountId, caravanId } = await fresh("s2");
    await setBalance(accountId, 240);
    const ids = await units(caravanId, 1, 2);
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const pv = await previewMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 + 10 * MS });
    expect(pv).toMatchObject({ balance: 250, pendingTrickle: 10, affordable: true });
    expect(await trickleEvents(accountId)).toEqual([]); // nothing written by a preview
    expect((await readCoinBalance(pool, accountId)).balance).toBe(240);
    const res = await performMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: t0 + 10 * MS });
    expect(res.preview!.balance).toBe(pv.balance);
    expect(res.balanceAfter).toBe(0);
  });

  it("S3: a non-uuid caravan id in the path is a 400, not a 500; non-object bodies are 400s", async () => {
    const { accountId } = await fresh("s3");
    const { token } = await issueSession(pool, accountId);
    const headers = { authorization: `Bearer ${token}` };
    const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    for (const url of ["/me/caravans/not-a-uuid/merge/preview", "/me/caravans/not-a-uuid/merge"]) {
      const r = await app.inject({ method: "POST", url, headers, payload: { instanceIds: ids } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_caravan_id");
    }
    for (const payload of ["[1,2]", '"str"', "null"]) {
      const r = await app.inject({ method: "POST", url: `/me/caravans/${accountId}/merge`, headers: { ...headers, "content-type": "application/json" }, payload });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_instance_ids");
    }
  });

  it("S4: polling writes one trickle row per threshold, not per read, and nothing at all at the cap", async () => {
    const { accountId } = await fresh("s4");
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    for (let i = 1; i <= 50; i++) await accrueTrickle(pool, accountId, t0 + i * MS);
    const below = await trickleEvents(accountId);
    expect(below.length).toBe(50 / MIN_COINS);
    expect(below.map((e) => e.payload["amount"])).toEqual(Array(50 / MIN_COINS).fill(MIN_COINS));
    expect((await accrueTrickle(pool, accountId, t0 + 50 * MS)).balance).toBe(50);
    await setBalance(accountId, CAP);
    for (let i = 51; i <= 100; i++) await accrueTrickle(pool, accountId, t0 + i * MS);
    const all = await trickleEvents(accountId);
    expect(all.length).toBe(below.length);
    expect(all.filter((e) => e.payload["amount"] === 0).length).toBe(0);
  });

  it("S5: spendCoin flushes the trickle, then debits; insufficient Coin is a 409 with nothing written", async () => {
    const { accountId } = await fresh("s5");
    await setBalance(accountId, 240);
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    const err = await appErr(withTransaction(pool, (c) => spendCoin(c, accountId, 250, "test_spend", t0 + 9 * MS, { causationId: "s5:too-poor" })));
    expect(err).toMatchObject({ statusCode: 409, code: "insufficient_coin" });
    expect((await listEventsForAccount(pool, accountId)).filter((e) => e.payload["reason"] !== "test_setup")).toEqual([]);
    const ok = await withTransaction(pool, (c) =>
      spendCoin(c, accountId, 250, "test_spend", t0 + 10 * MS, {
        causationId: "s5:ok",
        extra: { what: "x" },
        alongside: [{ type: "standing_party_saved", accountId, payload: { marker: 1 } }],
      }),
    );
    expect(ok.trickle.materialized).toBe(true);
    expect(ok).toMatchObject({ balanceBefore: 250, balanceAfter: 0 });
    expect(ok.events.map((e) => [e.event_type, e.causation_id, e.causation_seq])).toEqual([
      ["coin_spent", "s5:ok", 0],
      ["standing_party_saved", "s5:ok", 1],
    ]);
    expect(ok.events[0]!.payload).toMatchObject({ amount: 250, reason: "test_spend", what: "x" });
    expect((await readCoinBalance(pool, accountId)).balance).toBe(0);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("S6: ids are normalized to lowercase, so a retry in any casing replays the stored unit_merged payload", async () => {
    const { accountId, caravanId } = await fresh("s6");
    await setBalance(accountId, 5000);
    const ids = await units(caravanId, 1, 2);
    const upper = ids.map((s) => s.toUpperCase());
    const pv = await previewMerge(pool, { accountId, caravanId, instanceIds: upper });
    expect(pv.consumed.instanceIds.sort()).toEqual([...ids].sort());
    expect((await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: [ids[0]!, ids[0]!.toUpperCase()] }))).code).toBe("duplicate_instances");
    const first = await performMerge(pool, { accountId, caravanId, instanceIds: ids });
    const retry = await performMerge(pool, { accountId, caravanId: caravanId.toUpperCase(), instanceIds: upper });
    expect(retry.replayed).toBe(true);
    expect(retry.merged).toEqual(first.merged);
    expect(retry.consumedIds).toEqual(first.consumedIds);
    expect(retry.events.map((e) => e.seq)).toEqual(first.events.map((e) => e.seq));
    expect((await listEventsForAccount(pool, accountId)).filter((e) => e.event_type === "coin_spent").length).toBe(1);
    expect(first.events[0]!.causation_id).toBe(`merge:${caravanId}:${[...ids].sort().join(",")}`);
  });

  it("N1: prospectiveEarn must be a safe integer no larger than ten storage caps", async () => {
    const { accountId } = await fresh("n1");
    const { token } = await issueSession(pool, accountId);
    const headers = { authorization: `Bearer ${token}` };
    for (const q of ["1e308", "9007199254740993", "0x10", "1e3", "", "1.5", String(10 * CAP + 1)]) {
      const r = await app.inject({ method: "GET", url: `/me/economy?prospectiveEarn=${q}`, headers });
      expect(r.statusCode, q).toBe(400);
    }
    const multi = await app.inject({ method: "GET", url: "/me/economy?prospectiveEarn=1&prospectiveEarn=2", headers });
    expect(multi.statusCode).toBe(400);
    const ok = await app.inject({ method: "GET", url: `/me/economy?prospectiveEarn=${10 * CAP}`, headers });
    expect(ok.statusCode).toBe(200);
  });

  it("N2: a 20 000-id request is refused by the recipe check before any query", async () => {
    const { accountId, caravanId } = await fresh("n2");
    const { token } = await issueSession(pool, accountId);
    const many = Array.from({ length: 20_000 }, (_, i) => `${(i + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const r = await app.inject({ method: "POST", url: `/me/caravans/${caravanId}/merge/preview`, headers: { authorization: `Bearer ${token}` }, payload: { instanceIds: many } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("no_such_recipe");
  });

  it("N3: a malformed trickle row falls back to the previous valid one, and the generic credit path cannot write one", async () => {
    const { accountId } = await fresh("n3");
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    await accrueTrickle(pool, accountId, t0 + 10 * MS);
    expect(await readTrickleAccrualPoint(pool, accountId)).toBe(t0 + 10 * MS);
    // A row written past the economy module (the ledger accepts any integer-JSON payload).
    await withTransaction(pool, (c) =>
      appendEvents(c, "n3:forged", [{ type: "coin_earned", accountId, payload: { amount: 0, reason: "trickle", accruedThroughMs: "garbage" } }]),
    );
    await withTransaction(pool, (c) => appendEvents(c, "n3:forged2", [{ type: "coin_earned", accountId, payload: { amount: 0, reason: "trickle" } }]));
    expect(await readTrickleAccrualPoint(pool, accountId)).toBe(t0 + 10 * MS);
    expect((await accrueTrickle(pool, accountId, t0 + 12 * MS)).coins).toBe(2);
    await expect(
      withTransaction(pool, (c) => appendCoinCredits(c, { causationId: "n3:generic", accountId, credits: [{ amount: 1, reason: "trickle" }] })),
    ).rejects.toThrow(RangeError);
  });

  it("a clock that runs backwards, or an account created in the future, credits nothing", async () => {
    const { accountId } = await fresh("clock");
    const t0 = await readTrickleAccrualPoint(pool, accountId);
    await accrueTrickle(pool, accountId, t0 + 100 * MS);
    const back = await accrueTrickle(pool, accountId, t0 + 10 * MS);
    expect(back).toMatchObject({ coins: 0, pending: 0, balance: 100 });
    const future = await fresh("future");
    await pool.query("UPDATE account SET created_at = now() + interval '10 days' WHERE id = $1", [future.accountId]);
    expect((await accrueTrickle(pool, future.accountId, Date.now())).coins).toBe(0);
  });

  it("a merge moves Coin and the roster only: ladders and unlock points are untouched", async () => {
    const { accountId, caravanId } = await fresh("ledgeronly");
    await setBalance(accountId, 5000);
    const before = await pool.query("SELECT * FROM pool_progress WHERE account_id = $1 ORDER BY pool", [accountId]);
    const ids = await units(caravanId, 1, 2);
    await performMerge(pool, { accountId, caravanId, instanceIds: ids, nowMs: await readTrickleAccrualPoint(pool, accountId) });
    const after = await pool.query("SELECT * FROM pool_progress WHERE account_id = $1 ORDER BY pool", [accountId]);
    expect(after.rows).toEqual(before.rows);
  });
});

describe("QA round 1 punch list (roadmap/qa/17-punchlist.md)", () => {
  async function pack(caravanId: string, accountId: string, unitIds: string[]) {
    const { token } = await issueSession(pool, accountId);
    return app.inject({
      method: "POST",
      url: `/caravans/${caravanId}/manifest`,
      headers: { authorization: `Bearer ${token}` },
      payload: { units: unitIds, traps: [], fence: null },
    });
  }

  it("B1: a unit packed in an open manifest cannot be merged — preview and commit 409 unit_packed, whatever caravan.state says", async () => {
    const { accountId, caravanId } = await fresh("b1");
    await setBalance(accountId, 5000);
    const [p1, p2, f1, f2] = await units(caravanId, 1, 4);
    const packed = await pack(caravanId, accountId, [p1!, p2!]);
    expect(packed.statusCode).toBe(201);
    // Packing does not move the caravan state (chunk 15 does); the refusal must not depend on it.
    expect((await pool.query("SELECT state FROM caravan WHERE id = $1", [caravanId])).rows[0].state).toBe("in_town");
    for (const ids of [[p1!, p2!], [p1!, f1!], [f2!.toUpperCase(), p2!.toUpperCase()]]) {
      const pv = await appErr(previewMerge(pool, { accountId, caravanId, instanceIds: ids }));
      expect(pv).toMatchObject({ statusCode: 409, code: "unit_packed" });
      const cm = await appErr(performMerge(pool, { accountId, caravanId, instanceIds: ids, confirmInParty: true }));
      expect(cm).toMatchObject({ statusCode: 409, code: "unit_packed" });
    }
    const { token } = await issueSession(pool, accountId);
    for (const url of [`/me/caravans/${caravanId}/merge/preview`, `/me/caravans/${caravanId}/merge`]) {
      const http = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: { instanceIds: [p1, f1] } });
      expect(http.statusCode).toBe(409);
      expect(http.json()).toMatchObject({ error: "unit_packed", packed: [p1] });
    }
    // Nothing moved: roster, Coin.
    expect((await listUnitInstancesForCaravan(pool, caravanId)).map((r) => r.id).sort()).toEqual([p1, p2, f1, f2].sort());
    expect((await readCoinBalance(pool, accountId)).balance).toBe(5000);
    // A state flip either way changes nothing (the check reads the manifest, not the state).
    await pool.query("UPDATE caravan SET state = 'on_trip' WHERE id = $1", [caravanId]);
    await pool.query("UPDATE caravan SET state = 'in_town' WHERE id = $1", [caravanId]);
    expect(await appErr(performMerge(pool, { accountId, caravanId, instanceIds: [p1!, p2!] }))).toMatchObject({ code: "unit_packed" });
    // Units NOT packed merge normally while the manifest is open.
    expect((await performMerge(pool, { accountId, caravanId, instanceIds: [f1!, f2!] })).produced.length).toBe(1);
    // Once the trip ends (the manifest closes) the survivors are town units again.
    await pool.query("UPDATE wagon_manifest SET closed_at = now() WHERE caravan_id = $1 AND closed_at IS NULL", [caravanId]);
    expect((await performMerge(pool, { accountId, caravanId, instanceIds: [p1!, p2!] })).produced.length).toBe(1);
  });

  it("B1: pack and merge racing on the same units — exactly one succeeds", async () => {
    for (let round = 0; round < 6; round++) {
      const { accountId, caravanId } = await fresh(`b1race${round}`);
      await setBalance(accountId, 5000);
      const ids = await units(caravanId, 1, 2);
      const [packed, merged] = await Promise.allSettled([
        pack(caravanId, accountId, ids),
        performMerge(pool, { accountId, caravanId, instanceIds: ids }),
      ]);
      const packOk = packed.status === "fulfilled" && packed.value.statusCode === 201;
      const mergeOk = merged.status === "fulfilled";
      expect(packOk && mergeOk).toBe(false);
      expect(packOk || mergeOk).toBe(true);
      if (packOk) expect(merged).toMatchObject({ status: "rejected", reason: { code: "unit_packed" } });
    }
  });
});
