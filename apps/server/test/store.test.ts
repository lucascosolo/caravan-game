/**
 * Chunk 20 against the database: fixed tiers previewed exactly, the sandbox purchase
 * crediting through chunk 16's clamped credit path as `coin_purchased`, the storage cap
 * and the forecast agreeing, every tier once per week (serialized and raced), cosmetics
 * as account-level ownership with equip, the schema's CHECK on pack contents, and the
 * foreign-key graph proving nothing battle-side references any of it.
 */
import { COSMETIC_TYPES, TUNABLES, cosmeticEquipSlot, cosmeticOfferWeeks, getCosmeticType, packOffersForWeek, weekIndexAt } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { issueSession } from "../src/auth/sessions.js";
import { withTransaction } from "../src/db/pool.js";
import { appendCoinCredits, readCoinBalance, spendCoin } from "../src/economy/coin.js";
import { listEventsForAccount } from "../src/ledger/ledger.js";
import { verifyProjection } from "../src/ledger/projection.js";
import { AppError } from "../src/services/errors.js";
import { registerAccount } from "../src/services/onboarding.js";
import { equipCosmetic, listCosmetics, listPurchases, purchaseCausationId, purchasePack, storeView, unequipSlot } from "../src/store/index.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
const appRole = appRolePool();
let app: FastifyInstance;
const CAP = TUNABLES.COIN_STORAGE_CAP;
const PERIOD = TUNABLES.PACK_ROTATION_PERIOD_MS;
const NOW = Date.now();
const WEEK = weekIndexAt(NOW);

async function fresh(prefix: string) {
  const { account } = await registerAccount(pool, { username: unique(prefix), password: "password123", regionId: "desert" });
  return account.id;
}

async function setBalance(accountId: string, target: number) {
  const { balance } = await readCoinBalance(pool, accountId);
  const tag = unique("set");
  await withTransaction(pool, async (c) => {
    if (target > balance) await appendCoinCredits(c, { causationId: `test:${tag}`, accountId, credits: [{ amount: target - balance, reason: "test_setup" }] });
    else if (target < balance) await spendCoin(c, accountId, balance - target, "test_setup", NOW, { causationId: `test:${tag}` });
  });
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

async function purchasedEvents(accountId: string) {
  return (await listEventsForAccount(pool, accountId, { limit: 500 })).filter((e) => e.event_type === "coin_purchased");
}

async function ownedIds(accountId: string): Promise<string[]> {
  return (await pool.query<{ cosmetic_id: string }>("SELECT cosmetic_id FROM cosmetic_ownership WHERE account_id = $1 ORDER BY cosmetic_id", [accountId])).rows.map((r) => r.cosmetic_id);
}

beforeAll(async () => {
  await truncateAll(pool);
  app = await buildApp({ db: pool });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await appRole.end();
});

describe("the storefront previews exact contents before purchase (GUARDRAILS §4)", () => {
  it("three tiers: fixed prices, fixed Coin, the week's exact cosmetics, next week previewed, sandbox marked, ceiling documented", async () => {
    const accountId = await fresh("store");
    const view = await storeView(pool, accountId, NOW);
    expect(view.backend).toEqual({ name: "sandbox_stub", sandbox: true, realCharges: false, message: expect.stringMatching(/SANDBOX STUB.*charge nothing/) });
    expect(view.week.index).toBe(WEEK);
    expect(NOW).toBeGreaterThanOrEqual(view.week.startsAtMs);
    expect(NOW).toBeLessThan(view.week.endsAtMs);
    expect(view.offers.map((o) => [o.tier, o.priceCents, o.priceDisplay, o.coin])).toEqual([
      [1, 500, "$5", 6000],
      [2, 1000, "$10", 14_000],
      [3, 2500, "$25", 40_000],
    ]);
    const expected = packOffersForWeek(WEEK);
    for (let i = 0; i < 3; i++) {
      const o = view.offers[i]!;
      expect(o.id).toBe(expected[i]!.id);
      expect(o.cosmetics.map((c) => c.id)).toEqual(expected[i]!.cosmetics.map((c) => c.id));
      expect(o.contents).toEqual(expected[i]!.contents);
      // Every cosmetic is shown in full: name, kind, what it applies to, the readability review.
      for (const c of o.cosmetics) {
        const t = getCosmeticType(c.id)!;
        expect(c).toEqual({ id: t.id, kind: t.kind, displayName: t.displayName, description: t.description, appliesTo: t.appliesTo, reviewNote: t.reviewNote, slot: cosmeticEquipSlot(t) });
      }
      expect(o.purchased).toBe(false);
      expect(o.overflow.wouldDiscard).toBe(0);
    }
    expect(view.upcoming.map((u) => u.weekIndex)).toEqual([WEEK + 1]);
    expect(view.upcoming[0]!.offers.map((o) => o.cosmetics.map((c) => c.id))).toEqual(packOffersForWeek(WEEK + 1).map((o) => o.cosmetics.map((c) => c.id)));
    expect(view.upcoming[0]!.offers.map((o) => o.coin)).toEqual([6000, 14_000, 40_000]);
    expect(view.ceiling.weeklyPayCeiling).toBe(60_000);
    expect(view.ceiling.paidToFreeRatioBp).toBe(15_000);
    expect(view.ceiling.storageCap).toBe(CAP);
    expect(view.combined).toMatchObject({ tiers: [1, 2, 3], coin: 60_000 });
    expect(view.combined.overflow.wouldDiscard).toBe(10_000); // 60,000 into an empty 50,000 store
  });

  it("the overflow forecast is shown per tier and for all unpurchased tiers combined, and matches what a purchase then does", async () => {
    const accountId = await fresh("forecast");
    await setBalance(accountId, CAP - 1000);
    const view = await storeView(pool, accountId, NOW);
    expect(view.balance).toMatchObject({ balance: CAP - 1000, cap: CAP, room: 1000, atCap: false });
    expect(view.offers.map((o) => [o.overflow.wouldCredit, o.overflow.wouldDiscard, o.overflow.warn])).toEqual([
      [1000, 5000, true],
      [1000, 13_000, true],
      [1000, 39_000, true],
    ]);
    expect(view.offers[2]!.overflow.message).toMatch(/room for 1000 more Coin right now; 39000 of the 40000 Coin in this purchase would be discarded/);
    expect(view.combined.overflow).toMatchObject({ prospectiveEarn: 60_000, wouldCredit: 1000, wouldDiscard: 59_000 });
    const bought = await purchasePack(pool, { accountId, tier: 3, weekIndex: WEEK, nowMs: NOW });
    expect(bought.coin).toEqual({ requested: 40_000, credited: 1000, discarded: 39_000, balanceAfter: CAP, cap: CAP });
    expect(bought.events[0]!.payload).toMatchObject({ amount: 1000, overflowDiscarded: 39_000, reason: "pack_purchase", tier: 3 });
    expect(bought.purchase.coin).toEqual({ requested: 40_000, credited: 1000, discarded: 39_000 });
    expect((await readCoinBalance(pool, accountId)).balance).toBe(CAP);
    const after = await storeView(pool, accountId, NOW);
    expect(after.offers[2]).toMatchObject({ purchased: true, purchaseId: bought.purchase.id });
    expect(after.combined).toMatchObject({ tiers: [1, 2], coin: 20_000 });
    expect(after.combined.overflow).toMatchObject({ wouldCredit: 0, wouldDiscard: 20_000, atCap: true });
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });
});

describe("a purchase credits the normal balance as coin_purchased and grants account-level cosmetics", () => {
  it("one transaction: coin_purchased event, purchase row, ownership rows naming the purchase, projection intact", async () => {
    const accountId = await fresh("buy");
    const offer = packOffersForWeek(WEEK)[1]!;
    const r = await purchasePack(pool, { accountId, tier: 2, weekIndex: WEEK, nowMs: NOW });
    expect(r.coin).toEqual({ requested: 14_000, credited: 14_000, discarded: 0, balanceAfter: 14_000, cap: CAP });
    expect(r.offer).toEqual(offer);
    expect(r.cosmeticsGranted).toEqual(offer.cosmetics.map((c) => c.id));
    expect(r.cosmeticsAlreadyOwned).toEqual([]);
    expect(r.purchase).toMatchObject({ weekIndex: WEEK, tier: 2, backend: "sandbox_stub", priceCents: 1000, contents: offer.contents, causationId: purchaseCausationId(accountId, WEEK, 2) });
    expect(r.purchase.sandboxReceipt).toMatch(/^sandbox:/);
    const events = await purchasedEvents(accountId);
    expect(events).toHaveLength(1);
    expect(events[0]!.causation_id).toBe(purchaseCausationId(accountId, WEEK, 2));
    expect(events[0]!.caravan_id).toBeNull(); // account-level
    expect(events[0]!.payload).toEqual({
      amount: 14_000,
      reason: "pack_purchase",
      tier: 2,
      weekIndex: WEEK,
      priceCents: 1000,
      backend: "sandbox_stub",
      chargedCents: 0,
      cosmetics: offer.cosmetics.map((c) => c.id),
    });
    expect(await ownedIds(accountId)).toEqual([...offer.cosmetics.map((c) => c.id)].sort());
    const rows = await pool.query<{ purchase_id: string; kind: string }>("SELECT purchase_id, kind FROM cosmetic_ownership WHERE account_id = $1", [accountId]);
    for (const row of rows.rows) expect(row.purchase_id).toBe(r.purchase.id);
    expect(rows.rows.map((x) => x.kind).sort()).toEqual(offer.cosmetics.map((c) => c.kind).sort());
    expect((await readCoinBalance(pool, accountId)).balance).toBe(14_000);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
    expect((await listPurchases(pool, accountId)).map((p) => p.tier)).toEqual([2]);
  });

  it("all three tiers stack in one week; the combined 60,000 is what the ledger requested, clamped to the cap", async () => {
    const accountId = await fresh("stack");
    for (const tier of [1, 2, 3] as const) await purchasePack(pool, { accountId, tier, weekIndex: WEEK, nowMs: NOW });
    const events = await purchasedEvents(accountId);
    expect(events.map((e) => e.payload["tier"])).toEqual([1, 2, 3]);
    const requested = events.reduce((a, e) => a + (e.payload["amount"] as number) + ((e.payload["overflowDiscarded"] as number | undefined) ?? 0), 0);
    expect(requested).toBe(TUNABLES.WEEKLY_PAY_CEILING);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(CAP);
    expect(events[2]!.payload["overflowDiscarded"]).toBe(10_000);
    const view = await storeView(pool, accountId, NOW);
    expect(view.offers.every((o) => o.purchased)).toBe(true);
    expect(view.combined).toMatchObject({ tiers: [], coin: 0 });
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("a cosmetic that rotates back is not granted twice: the second purchase reports it already owned", async () => {
    const accountId = await fresh("return");
    const first = packOffersForWeek(WEEK)[0]!;
    const id = first.cosmetics[0]!.id;
    await purchasePack(pool, { accountId, tier: 1, weekIndex: WEEK, nowMs: NOW });
    const next = cosmeticOfferWeeks(id, WEEK + 1, 520)[0];
    expect(next).toBeDefined();
    const nowThen = NOW + (next!.weekIndex - WEEK) * PERIOD;
    expect(weekIndexAt(nowThen)).toBe(next!.weekIndex);
    const r = await purchasePack(pool, { accountId, tier: next!.tier as 1 | 2 | 3, weekIndex: next!.weekIndex, nowMs: nowThen });
    expect(r.cosmeticsAlreadyOwned).toEqual([id]);
    expect(r.cosmeticsGranted).not.toContain(id);
    const owned = await ownedIds(accountId);
    expect(new Set(owned).size).toBe(owned.length);
    expect(owned).toContain(id);
  });
});

describe("each tier once per week, stackable across tiers (PURCHASE_LIMIT)", () => {
  it("the same tier twice in one week is refused; next week it is open again; the ledger has one coin_purchased per (week, tier)", async () => {
    const accountId = await fresh("limit");
    await purchasePack(pool, { accountId, tier: 1, weekIndex: WEEK, nowMs: NOW });
    const again = await appErr(purchasePack(pool, { accountId, tier: 1, weekIndex: WEEK, nowMs: NOW + 1000 }));
    expect(again.statusCode).toBe(409);
    expect(again.code).toBe("tier_already_purchased_this_week");
    expect((await readCoinBalance(pool, accountId)).balance).toBe(6000);
    // Other tiers are still open this week.
    await purchasePack(pool, { accountId, tier: 2, weekIndex: WEEK, nowMs: NOW });
    // Next week, tier 1 again.
    const nextWeekNow = NOW + PERIOD;
    const r = await purchasePack(pool, { accountId, tier: 1, weekIndex: WEEK + 1, nowMs: nextWeekNow });
    expect(r.purchase.weekIndex).toBe(WEEK + 1);
    const events = await purchasedEvents(accountId);
    expect(events.map((e) => [e.payload["weekIndex"], e.payload["tier"]])).toEqual([
      [WEEK, 1],
      [WEEK, 2],
      [WEEK + 1, 1],
    ]);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(26_000);
  });

  it("a stale preview (a week that has rolled over) is refused and nothing is written", async () => {
    const accountId = await fresh("stale");
    const e = await appErr(purchasePack(pool, { accountId, tier: 1, weekIndex: WEEK - 1, nowMs: NOW }));
    expect(e.code).toBe("offer_not_current");
    const f = await appErr(purchasePack(pool, { accountId, tier: 1, weekIndex: WEEK + 1, nowMs: NOW }));
    expect(f.code).toBe("offer_not_current");
    expect((await appErr(purchasePack(pool, { accountId, tier: 4, weekIndex: WEEK, nowMs: NOW }))).code).toBe("invalid_tier");
    expect((await appErr(purchasePack(pool, { accountId, tier: "1", weekIndex: WEEK, nowMs: NOW }))).code).toBe("invalid_tier");
    expect((await appErr(purchasePack(pool, { accountId, tier: 1, weekIndex: "now", nowMs: NOW }))).code).toBe("invalid_week");
    expect(await purchasedEvents(accountId)).toEqual([]);
    expect((await listPurchases(pool, accountId)).length).toBe(0);
    expect(await ownedIds(accountId)).toEqual([]);
  });

  it("eight concurrent purchases of one tier: exactly one succeeds, one coin_purchased, Coin credited once", async () => {
    const accountId = await fresh("race");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => purchasePack(pool, { accountId, tier: 2, weekIndex: WEEK, nowMs: NOW })));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(7);
    for (const f of failed) expect((f.reason as AppError).code).toBe("tier_already_purchased_this_week");
    expect(await purchasedEvents(accountId)).toHaveLength(1);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(14_000);
    expect((await pool.query("SELECT count(*)::int AS n FROM pack_purchase WHERE account_id = $1", [accountId])).rows[0]).toEqual({ n: 1 });
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });

  it("twelve concurrent purchases across all tiers near the cap: exactly three succeed and the cap is never passed", async () => {
    const accountId = await fresh("race3");
    await setBalance(accountId, CAP - 10_000);
    const tiers = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3] as const;
    const results = await Promise.allSettled(tiers.map((tier) => purchasePack(pool, { accountId, tier, weekIndex: WEEK, nowMs: NOW })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const events = await purchasedEvents(accountId);
    expect(events.map((e) => e.payload["tier"]).sort()).toEqual([1, 2, 3]);
    const credited = events.reduce((a, e) => a + (e.payload["amount"] as number), 0);
    const discarded = events.reduce((a, e) => a + ((e.payload["overflowDiscarded"] as number | undefined) ?? 0), 0);
    expect(credited).toBe(10_000);
    expect(credited + discarded).toBe(60_000);
    expect((await readCoinBalance(pool, accountId)).balance).toBe(CAP);
    expect((await verifyProjection(pool, accountId)).ok).toBe(true);
  });
});

describe("cosmetics: account-level ownership and the equip preference", () => {
  it("owned / equipped / catalog with next-offer weeks; equip requires ownership; one per slot; unequip clears", async () => {
    const accountId = await fresh("cosm");
    const before = await listCosmetics(pool, accountId, NOW);
    expect(before.owned).toEqual([]);
    expect(before.equipped).toEqual({});
    expect(before.catalog.map((c) => c.id)).toEqual(COSMETIC_TYPES.map((c) => c.id));
    expect(before.catalog.every((c) => !c.owned)).toBe(true);
    // Every catalog entry's next offer is a real week in which it is offered.
    for (const c of before.catalog) {
      expect(c.nextOffer).not.toBeNull();
      expect(packOffersForWeek(c.nextOffer!.weekIndex)[c.nextOffer!.tier - 1]!.cosmetics.map((x) => x.id)).toContain(c.id);
    }
    const offer = packOffersForWeek(WEEK)[2]!;
    await purchasePack(pool, { accountId, tier: 3, weekIndex: WEEK, nowMs: NOW });
    const after = await listCosmetics(pool, accountId, NOW);
    expect(after.owned.map((c) => c.id).sort()).toEqual(offer.cosmetics.map((c) => c.id).sort());
    expect(after.owned.every((c) => !c.equipped)).toBe(true);
    const target = offer.cosmetics[0]!;
    const eq = await equipCosmetic(pool, accountId, target.id);
    expect(eq).toEqual({ slot: cosmeticEquipSlot(target), cosmeticId: target.id, equipped: { [cosmeticEquipSlot(target)]: target.id } });
    expect((await listCosmetics(pool, accountId, NOW)).owned.find((c) => c.id === target.id)!.equipped).toBe(true);
    // Not owned: refused. Unknown: 404. Non-string: 400.
    const notOwned = COSMETIC_TYPES.find((c) => !offer.cosmetics.some((o) => o.id === c.id))!;
    expect((await appErr(equipCosmetic(pool, accountId, notOwned.id))).code).toBe("not_owned");
    expect((await appErr(equipCosmetic(pool, accountId, "skin.nope"))).statusCode).toBe(404);
    expect((await appErr(equipCosmetic(pool, accountId, 7))).statusCode).toBe(400);
    // One per slot: a second owned cosmetic of the same slot replaces the first.
    const sameSlot = offer.cosmetics.find((c) => c.id !== target.id && cosmeticEquipSlot(c) === cosmeticEquipSlot(target));
    if (sameSlot) {
      const re = await equipCosmetic(pool, accountId, sameSlot.id);
      expect(re.equipped).toEqual({ [cosmeticEquipSlot(target)]: sameSlot.id });
    }
    const cleared = await unequipSlot(pool, accountId, cosmeticEquipSlot(target));
    expect(cleared.cleared).toBe(true);
    expect(cleared.equipped).toEqual({});
    expect((await unequipSlot(pool, accountId, cosmeticEquipSlot(target))).cleared).toBe(false);
    expect((await appErr(unequipSlot(pool, accountId, "hat"))).code).toBe("invalid_slot");
    expect((await appErr(unequipSlot(pool, accountId, "unit_skin:desert.nobody"))).code).toBe("invalid_slot");
  });

  it("ownership is account-level: no caravan column, and it survives the caravan's roster entirely", async () => {
    for (const t of ["pack_purchase", "cosmetic_ownership", "cosmetic_equip"]) {
      const cols = (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [t])).rows.map((c) => c.column_name);
      expect(cols, t).toContain("account_id");
      expect(cols.filter((c) => /caravan|unit|merge|slot_count|hp|damage|stat/.test(c)), t).toEqual([]);
    }
  });
});

describe("HTTP: /me/store and /me/cosmetics", () => {
  it("preview → purchase (201) → purchases list → cosmetics → equip/unequip; auth required; the repeat is 409", async () => {
    const accountId = await fresh("http");
    const { token } = await issueSession(pool, accountId);
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "GET", url: "/me/store" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/me/store/purchase", payload: { tier: 1, weekIndex: 0 } })).statusCode).toBe(401);
    const store = await app.inject({ method: "GET", url: "/me/store", headers });
    expect(store.statusCode).toBe(200);
    const view = store.json();
    expect(view.backend.sandbox).toBe(true);
    expect(view.offers).toHaveLength(3);
    const week = view.week.index as number;
    const buy = await app.inject({ method: "POST", url: "/me/store/purchase", headers, payload: { tier: 1, weekIndex: week } });
    expect(buy.statusCode).toBe(201);
    const body = buy.json();
    expect(body.sandbox).toBe(true);
    expect(body.coin).toMatchObject({ requested: 6000, credited: 6000, discarded: 0 });
    expect(body.events).toEqual([{ seq: expect.any(Number), type: "coin_purchased", payload: expect.objectContaining({ amount: 6000, tier: 1 }) }]);
    expect(body.cosmeticsGranted).toEqual(view.offers[0].cosmetics.map((c: { id: string }) => c.id));
    const repeat = await app.inject({ method: "POST", url: "/me/store/purchase", headers, payload: { tier: 1, weekIndex: week } });
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json().error).toBe("tier_already_purchased_this_week");
    expect((await app.inject({ method: "POST", url: "/me/store/purchase", headers, payload: { tier: 1, weekIndex: week + 1 } })).json().error).toBe("offer_not_current");
    expect((await app.inject({ method: "POST", url: "/me/store/purchase", headers, payload: [1] })).statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: "/me/store/purchases", headers });
    expect(list.json().purchases.map((p: { tier: number }) => p.tier)).toEqual([1]);
    const econ = await app.inject({ method: "GET", url: "/me/economy", headers });
    expect(econ.json().balance).toBe(6000);
    const cosmetics = await app.inject({ method: "GET", url: "/me/cosmetics", headers });
    expect(cosmetics.statusCode).toBe(200);
    const owned = cosmetics.json().owned as { id: string; slot: string }[];
    expect(owned.map((c) => c.id)).toEqual(body.cosmeticsGranted);
    const equip = await app.inject({ method: "POST", url: "/me/cosmetics/equip", headers, payload: { cosmeticId: owned[0]!.id } });
    expect(equip.statusCode).toBe(200);
    expect(equip.json().equipped).toEqual({ [owned[0]!.slot]: owned[0]!.id });
    const unequip = await app.inject({ method: "POST", url: "/me/cosmetics/unequip", headers, payload: { slot: owned[0]!.slot } });
    expect(unequip.json()).toMatchObject({ cleared: true, equipped: {} });
    expect((await app.inject({ method: "POST", url: "/me/cosmetics/equip", headers, payload: { cosmeticId: "banner.nope" } })).statusCode).toBe(404);
  });
});

describe("the schema holds against the app role", () => {
  it("pack contents may hold only coin and cosmetic entries; every forbidden kind is refused by CHECK", async () => {
    const accountId = await fresh("check");
    const insert = (contents: unknown, tier = 1, backend = "sandbox_stub") =>
      expectDbError(
        appRole,
        `INSERT INTO pack_purchase (account_id, week_index, tier, backend, sandbox_receipt, price_cents, contents, coin_requested, coin_credited, coin_discarded, causation_id)
         VALUES ($1, 999, $2, $3, 'sandbox:test', 500, $4::jsonb, 0, 0, 0, $5)`,
        [accountId, tier, backend, JSON.stringify(contents), `test:${unique("c")}`],
      );
    const forbidden = ["unlock_points", "unit", "unit_access", "trip_cap", "trip_cap_uses", "slot", "slot_count", "fence_material", "repair", "resupply", "reroll", "merge_level", "reputation", "ladder"];
    for (const kind of forbidden) {
      const err = await insert([{ kind, amount: 1 }]);
      expect(err?.code, kind).toBe("23514");
      const mixed = await insert([{ kind: "coin", amount: 6000 }, { kind, cosmeticId: "x" }]);
      expect(mixed?.code, `coin + ${kind}`).toBe("23514");
    }
    // Shape: extra keys, a float amount, a negative amount, an empty list, a non-array.
    expect((await insert([{ kind: "coin", amount: 6000, bonus: 1 }]))?.code).toBe("23514");
    expect((await insert([{ kind: "coin", amount: 1.5 }]))?.code).toBe("23514");
    expect((await insert([{ kind: "coin", amount: -1 }]))?.code).toBe("23514");
    expect((await insert([{ kind: "cosmetic", cosmeticId: "x", stat: 1 }]))?.code).toBe("23514");
    expect((await insert([]))?.code).toBe("23514");
    expect((await insert({ kind: "coin", amount: 1 }))?.code).toBe("23514");
    // Backend: only the sandbox stub exists.
    expect((await insert([{ kind: "coin", amount: 1 }], 1, "stripe"))?.code).toBe("23514");
    expect((await insert([{ kind: "coin", amount: 1 }], 4))?.code).toBe("23514");
    // A well-formed row is accepted (so the refusals above are the CHECK, not the shape).
    expect(await insert([{ kind: "coin", amount: 6000 }, { kind: "cosmetic", cosmeticId: "banner.lone_star" }])).toBeNull();
    // ... and the same (account, week, tier) again is the unique constraint.
    expect((await insert([{ kind: "coin", amount: 6000 }]))?.code).toBe("23505");
  });

  it("purchase and ownership rows are immutable records; equip needs ownership (FK); truncate refused", async () => {
    const accountId = await fresh("guard");
    const r = await purchasePack(pool, { accountId, tier: 1, weekIndex: WEEK, nowMs: NOW });
    expect((await expectDbError(appRole, "UPDATE pack_purchase SET coin_credited = 1 WHERE id = $1", [r.purchase.id]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE pack_purchase SET contents = '[{\"kind\":\"coin\",\"amount\":1}]'::jsonb WHERE id = $1", [r.purchase.id]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "DELETE FROM pack_purchase WHERE id = $1", [r.purchase.id]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "TRUNCATE pack_purchase"))?.code).toMatch(/42501|23514/);
    const owned = r.cosmeticsGranted[0]!;
    expect((await expectDbError(appRole, "UPDATE cosmetic_ownership SET cosmetic_id = 'x' WHERE account_id = $1 AND cosmetic_id = $2", [accountId, owned]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "DELETE FROM cosmetic_ownership WHERE account_id = $1", [accountId]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "TRUNCATE cosmetic_ownership"))?.code).toMatch(/42501|23514/);
    // Ownership always names a purchase (no cosmetic from anywhere else in v1).
    expect((await expectDbError(appRole, "INSERT INTO cosmetic_ownership (account_id, cosmetic_id, kind, purchase_id) VALUES ($1, 'banner.lone_star', 'party_banner', NULL)", [accountId]))?.code).toBe("23502");
    expect((await expectDbError(appRole, "INSERT INTO cosmetic_ownership (account_id, cosmetic_id, kind, purchase_id) VALUES ($1, 'banner.x', 'hat', $2)", [accountId, r.purchase.id]))?.code).toBe("23514");
    // Equip of an unowned cosmetic fails the FK even if the service were bypassed.
    const unowned = COSMETIC_TYPES.find((c) => !r.cosmeticsGranted.includes(c.id))!;
    expect((await expectDbError(appRole, "INSERT INTO cosmetic_equip (account_id, slot, cosmetic_id) VALUES ($1, $2, $3)", [accountId, cosmeticEquipSlot(unowned), unowned.id]))?.code).toBe("23503");
  });

  it("nothing battle-side references the store: the FK graph of pack_purchase / cosmetic_* touches only account and each other", async () => {
    const fks = await pool.query<{ from_table: string; to_table: string }>(
      `SELECT c.conrelid::regclass::text AS from_table, c.confrelid::regclass::text AS to_table
       FROM pg_constraint c WHERE c.contype = 'f'`,
    );
    const storeTables = new Set(["pack_purchase", "cosmetic_ownership", "cosmetic_equip"]);
    const into = fks.rows.filter((f) => storeTables.has(f.to_table));
    for (const f of into) expect(storeTables.has(f.from_table), `${f.from_table} -> ${f.to_table}`).toBe(true);
    const outOf = fks.rows.filter((f) => storeTables.has(f.from_table));
    for (const f of outOf) expect(["account", "pack_purchase", "cosmetic_ownership"].includes(f.to_table), `${f.from_table} -> ${f.to_table}`).toBe(true);
    expect(into.length).toBeGreaterThan(0);
    // And no battle-side table has a column that could point at one by name.
    for (const t of ["resolution_job", "wagon_formation", "wagon_manifest", "standing_party", "trip", "encounter_candidates", "unit_instance", "caravan"]) {
      const cols = (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [t])).rows.map((c) => c.column_name);
      expect(cols.filter((c) => /purchase|cosmetic|skin|banner|entitle|pack_/.test(c)), t).toEqual([]);
    }
  });
});
