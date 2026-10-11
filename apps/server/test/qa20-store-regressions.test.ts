/**
 * QA-20 regressions (roadmap/qa/20-punchlist.md), built from the reviewer's probe:
 *   D1  a repeat of a tier in the same week is a replay of the stored purchase;
 *   D2  reserve → charge (idempotency key = causationId) → credit + settle, and resume;
 *   S1  the pending trickle is force-flushed before the credit (forecast == record);
 *   S2  the purchase carries `contentsHash`; a mismatch is 409 `offer_changed`;
 *   N3  ownership rebuilt from the ledger alone ("first event naming an id owns it");
 *   probe P2 (week boundary), P4 (foreign-region skin), P5 (malformed HTTP bodies).
 */
import { TUNABLES, cosmeticOfferWeeks, packOfferForWeek, packOffersForWeek, weekBounds, weekIndexAt } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { issueSession } from "../src/auth/sessions.js";
import { withTransaction } from "../src/db/pool.js";
import { appendCoinCredits, readCoinBalance } from "../src/economy/coin.js";
import { peekTrickle } from "../src/economy/trickle.js";
import { listEventsForAccount } from "../src/ledger/ledger.js";
import { verifyProjection } from "../src/ledger/projection.js";
import { AppError } from "../src/services/errors.js";
import { registerAccount } from "../src/services/onboarding.js";
import {
  SANDBOX_PURCHASE_BACKEND,
  equipCosmetic,
  listPurchases,
  offerContentsHash,
  purchaseCausationId,
  purchasePack,
  storeView,
  type PurchaseBackend,
} from "../src/store/index.js";
import { appRolePool, expectDbError, testPool, truncateAll, unique } from "./helpers.js";

const pool = testPool();
const appRole = appRolePool();
let app: FastifyInstance;
const CAP = TUNABLES.COIN_STORAGE_CAP;
const PERIOD = TUNABLES.PACK_ROTATION_PERIOD_MS;
const NOW = Date.now();
const WEEK = weekIndexAt(NOW);
const HOUR = 3_600_000;
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fresh(prefix: string) {
  const { account } = await registerAccount(pool, { username: unique(prefix), password: "password123", regionId: "desert" });
  return account.id;
}

async function credit(accountId: string, amount: number) {
  await withTransaction(pool, (c) => appendCoinCredits(c, { causationId: `test:${unique("c")}`, accountId, credits: [{ amount, reason: "test_setup" }] }));
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

async function eventsOf(accountId: string) {
  return listEventsForAccount(pool, accountId, { limit: 500 });
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

describe("QA-20 S1: the purchase credits against the balance the store showed (pending trickle flushed first)", () => {
  it("probe P1: two hours of trickle pending near the cap — the forecast and the recorded credit agree, and the trickle is written, not eaten", async () => {
    const a = await fresh("s1");
    await credit(a, CAP - 1000);
    const later = NOW + 2 * HOUR;
    const peek = await peekTrickle(pool, a, later);
    expect(peek.pending).toBeGreaterThanOrEqual(399); // ~400 coins of trickle (200/h), less the ms since NOW
    expect(peek.pending).toBeLessThanOrEqual(400);
    const view = await storeView(pool, a, later);
    expect(view.balance.balance).toBe(CAP - 1000 + peek.pending);
    const forecast = view.offers[0]!.overflow;
    expect(forecast.wouldCredit).toBe(1000 - peek.pending);

    const r = await purchasePack(pool, { accountId: a, tier: 1, weekIndex: weekIndexAt(later), nowMs: later, contentsHash: view.offers[0]!.contentsHash });
    // The trickle was flushed under the lock, before the credit, and surfaced.
    expect(r.trickle).toMatchObject({ materialized: true, credited: peek.pending, discarded: 0, balanceBeforeCredit: CAP - 1000 + peek.pending });
    // What the preview said is exactly what the purchase recorded.
    expect([r.coin.credited, r.coin.discarded]).toEqual([forecast.wouldCredit, forecast.wouldDiscard]);
    expect(r.purchase.coin).toEqual({ requested: 6000, credited: forecast.wouldCredit, discarded: forecast.wouldDiscard });
    expect(r.coin.balanceAfter).toBe(CAP);
    // The ledger holds the trickle event, then the purchase.
    const evs = (await eventsOf(a)).filter((e) => e.event_type === "coin_earned" || e.event_type === "coin_purchased");
    const trickle = evs.find((e) => e.payload["reason"] === "trickle");
    expect(trickle?.payload["amount"]).toBe(peek.pending);
    const bought = evs.find((e) => e.event_type === "coin_purchased")!;
    expect(bought.seq).toBeGreaterThan(trickle!.seq);
    expect(bought.payload).toMatchObject({ amount: forecast.wouldCredit, overflowDiscarded: forecast.wouldDiscard });
    expect((await readCoinBalance(pool, a)).balance).toBe(CAP);
    expect((await verifyProjection(pool, a)).ok).toBe(true);
  });

  it("the source orders it: lock → … → accrueTrickleTx(force) → appendCoinCredits", () => {
    const src = readFileSync(join(SERVER, "src", "store", "purchase.ts"), "utf8");
    const lock = src.indexOf("await lockAccountForAppend(client");
    const flush = src.indexOf("accrueTrickleTx(client, input.accountId, input.nowMs, { force: true })");
    const creditAt = src.indexOf("await appendCoinCredits(client");
    expect(lock).toBeGreaterThan(0);
    expect(flush).toBeGreaterThan(lock);
    expect(creditAt).toBeGreaterThan(flush);
  });
});

describe("QA-20 S2: the purchase carries a fingerprint of the previewed contents", () => {
  it("the store shows sha256 of the canonical contents; a mismatched hash is 409 offer_changed and nothing is written; the right one buys", async () => {
    const a = await fresh("s2");
    const view = await storeView(pool, a, NOW);
    for (const o of view.offers) expect(o.contentsHash).toBe(offerContentsHash(packOfferForWeek(WEEK, o.tier).contents));
    expect(new Set(view.offers.map((o) => o.contentsHash)).size).toBe(3);
    const stale = await appErr(purchasePack(pool, { accountId: a, tier: 2, weekIndex: WEEK, nowMs: NOW, contentsHash: view.offers[0]!.contentsHash }));
    expect([stale.statusCode, stale.code]).toEqual([409, "offer_changed"]);
    expect((await appErr(purchasePack(pool, { accountId: a, tier: 2, weekIndex: WEEK, nowMs: NOW, contentsHash: "Z".repeat(64) }))).code).toBe("invalid_contents_hash");
    expect((await appErr(purchasePack(pool, { accountId: a, tier: 2, weekIndex: WEEK, nowMs: NOW, contentsHash: 7 }))).code).toBe("invalid_contents_hash");
    expect(await listPurchases(pool, a)).toEqual([]);
    expect((await eventsOf(a)).filter((e) => e.event_type === "coin_purchased")).toEqual([]);
    const ok = await purchasePack(pool, { accountId: a, tier: 2, weekIndex: WEEK, nowMs: NOW, contentsHash: view.offers[1]!.contentsHash });
    expect(ok.replayed).toBe(false);
    expect(offerContentsHash(ok.purchase.contents)).toBe(view.offers[1]!.contentsHash);
    // The upcoming week's offers carry their own hashes too.
    expect(view.upcoming[0]!.offers[0]!.contentsHash).toBe(offerContentsHash(packOfferForWeek(WEEK + 1, 1).contents));
  });
});

describe("QA-20 D1: a repeat purchase is a replay", () => {
  it("replay returns the stored purchase view and the stored coin_purchased event, moves nothing, and ignores a since-changed hash", async () => {
    const a = await fresh("d1");
    const first = await purchasePack(pool, { accountId: a, tier: 3, weekIndex: WEEK, nowMs: NOW });
    const before = await eventsOf(a);
    const again = await purchasePack(pool, { accountId: a, tier: 3, weekIndex: WEEK, nowMs: NOW + 5000, contentsHash: "0".repeat(64) });
    expect(again).toMatchObject({ replayed: true, resumed: false, trickle: null });
    expect(again.purchase).toEqual(first.purchase);
    expect(again.events).toHaveLength(1);
    expect(again.events[0]!.seq).toBe(first.events[0]!.seq);
    expect(again.events[0]!.event_type).toBe("coin_purchased");
    expect(await eventsOf(a)).toHaveLength(before.length);
    expect((await readCoinBalance(pool, a)).balance).toBe(40_000);
  });
});

describe("QA-20 D2: reserve → charge (keyed) → credit + settle", () => {
  it("the source orders it: INSERT reservation, then charge with the causation id, then credit, then settle", () => {
    const src = readFileSync(join(SERVER, "src", "store", "purchase.ts"), "utf8");
    const reserve = src.indexOf("INSERT INTO pack_purchase");
    const charge = src.indexOf("backend.charge({ accountId: input.accountId, offer, idempotencyKey: reservation.causation_id })");
    const creditAt = src.indexOf("await appendCoinCredits(client");
    const settle = src.indexOf("UPDATE pack_purchase SET sandbox_receipt");
    expect(reserve).toBeGreaterThan(0);
    expect(charge).toBeGreaterThan(reserve);
    expect(creditAt).toBeGreaterThan(charge);
    expect(settle).toBeGreaterThan(creditAt);
  });

  it("the backend is called once, with idempotencyKey = causationId; a failing charge leaves nothing behind", async () => {
    const a = await fresh("d2");
    const keys: string[] = [];
    const spy: PurchaseBackend = { name: "sandbox_stub", charge: (req) => (keys.push(req.idempotencyKey), SANDBOX_PURCHASE_BACKEND.charge(req)) };
    const r = await purchasePack(pool, { accountId: a, tier: 1, weekIndex: WEEK, nowMs: NOW, backend: spy });
    expect(keys).toEqual([purchaseCausationId(a, WEEK, 1)]);
    expect(r.purchase).toMatchObject({ settled: true, causationId: keys[0] });
    expect(r.purchase.sandboxReceipt).toBe(SANDBOX_PURCHASE_BACKEND.charge({ accountId: a, offer: r.offer, idempotencyKey: keys[0]! }).receipt);
    // A replay does not charge again.
    await purchasePack(pool, { accountId: a, tier: 1, weekIndex: WEEK, nowMs: NOW, backend: spy });
    expect(keys).toHaveLength(1);

    const declining: PurchaseBackend = { name: "sandbox_stub", charge: () => { throw new Error("declined"); } };
    await expect(purchasePack(pool, { accountId: a, tier: 2, weekIndex: WEEK, nowMs: NOW, backend: declining })).rejects.toThrow("declined");
    expect((await listPurchases(pool, a)).map((p) => p.tier)).toEqual([1]);
    expect((await eventsOf(a)).filter((e) => e.event_type === "coin_purchased")).toHaveLength(1);
  });

  it("an unsettled reservation is RESUMED with the same key: charged, credited, settled once; then replays", async () => {
    const a = await fresh("d2r");
    const offer = packOfferForWeek(WEEK, 2);
    const cid = purchaseCausationId(a, WEEK, 2);
    // A reservation as a crash between RESERVE and CHARGE would leave it (written by the app role).
    expect(
      await expectDbError(
        appRole,
        `INSERT INTO pack_purchase (account_id, week_index, tier, backend, price_cents, contents, coin_requested, coin_credited, coin_discarded, causation_id)
         VALUES ($1, $2, 2, 'sandbox_stub', $3, $4::jsonb, $5, 0, 0, $6)`,
        [a, WEEK, offer.priceCents, JSON.stringify(offer.contents), offer.coin, cid],
      ),
    ).toBeNull();
    const pending = (await storeView(pool, a, NOW)).offers[1]!;
    expect(pending.purchased).toBe(true); // a reservation holds the tier
    const keys: string[] = [];
    const spy: PurchaseBackend = { name: "sandbox_stub", charge: (req) => (keys.push(req.idempotencyKey), SANDBOX_PURCHASE_BACKEND.charge(req)) };
    const r = await purchasePack(pool, { accountId: a, tier: 2, weekIndex: WEEK, nowMs: NOW, backend: spy, contentsHash: offerContentsHash(offer.contents) });
    expect(r).toMatchObject({ replayed: false, resumed: true });
    expect(keys).toEqual([cid]);
    expect(r.purchase).toMatchObject({ settled: true, coin: { requested: 14_000, credited: 14_000, discarded: 0 } });
    expect(r.cosmeticsGranted).toEqual(offer.cosmetics.map((c) => c.id));
    expect((await readCoinBalance(pool, a)).balance).toBe(14_000);
    const again = await purchasePack(pool, { accountId: a, tier: 2, weekIndex: WEEK, nowMs: NOW, backend: spy });
    expect(again.replayed).toBe(true);
    expect(keys).toHaveLength(1);
    expect((await verifyProjection(pool, a)).ok).toBe(true);
  });

  it("the schema: a reservation settles exactly once, touching only receipt / credited / discarded / settled_at", async () => {
    const a = await fresh("d2s");
    const offer = packOfferForWeek(WEEK, 1);
    const res = await appRole.query<{ id: string }>(
      `INSERT INTO pack_purchase (account_id, week_index, tier, backend, price_cents, contents, coin_requested, coin_credited, coin_discarded, causation_id)
       VALUES ($1, $2, 1, 'sandbox_stub', 500, $3::jsonb, 6000, 0, 0, $4) RETURNING id`,
      [a, WEEK, JSON.stringify(offer.contents), `test:${unique("r")}`],
    );
    const id = res.rows[0]!.id;
    // A reservation may not carry a receipt or a credit before it settles.
    expect((await expectDbError(appRole, "UPDATE pack_purchase SET coin_credited = 6000 WHERE id = $1", [id]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE pack_purchase SET sandbox_receipt = 'sandbox:x' WHERE id = $1", [id]))?.code).toBe("23514");
    // Settling with the coin unaccounted for is refused by the settlement CHECK.
    expect((await expectDbError(appRole, "UPDATE pack_purchase SET sandbox_receipt = 'sandbox:x', coin_credited = 1, settled_at = now() WHERE id = $1", [id]))?.code).toBe("23514");
    // Settling while changing anything else is refused by the guard.
    expect((await expectDbError(appRole, "UPDATE pack_purchase SET sandbox_receipt = 'sandbox:x', coin_credited = 6000, settled_at = now(), price_cents = 1 WHERE id = $1", [id]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE pack_purchase SET sandbox_receipt = 'sandbox:x', coin_credited = 6000, settled_at = now(), tier = 2 WHERE id = $1", [id]))?.code).toBe("23514");
    // A reservation is a record too: it does not leave while its account exists.
    expect((await expectDbError(appRole, "DELETE FROM pack_purchase WHERE id = $1", [id]))?.code).toBe("23514");
    // The settlement itself is admitted, once.
    expect(await expectDbError(appRole, "UPDATE pack_purchase SET sandbox_receipt = 'sandbox:x', coin_credited = 1000, coin_discarded = 5000, settled_at = now() WHERE id = $1", [id])).toBeNull();
    expect((await expectDbError(appRole, "UPDATE pack_purchase SET sandbox_receipt = 'sandbox:y', settled_at = now() WHERE id = $1", [id]))?.code).toBe("23514");
    expect((await expectDbError(appRole, "UPDATE pack_purchase SET settled_at = NULL, sandbox_receipt = NULL, coin_credited = 0, coin_discarded = 0 WHERE id = $1", [id]))?.code).toBe("23514");
  });
});

describe("QA-20 N3 / probe P3: ownership rebuilt from the ledger alone matches cosmetic_ownership", () => {
  it("first coin_purchased event (ledger order) naming an id owns it — including a cosmetic that rotated back", async () => {
    const a = await fresh("n3");
    for (const t of [1, 2, 3] as const) await purchasePack(pool, { accountId: a, tier: t, weekIndex: WEEK, nowMs: NOW });
    const firstId = packOffersForWeek(WEEK)[0]!.cosmetics[0]!.id;
    const nxt = cosmeticOfferWeeks(firstId, WEEK + 1, 520)[0]!;
    const then = NOW + (nxt.weekIndex - WEEK) * PERIOD;
    const back = await purchasePack(pool, { accountId: a, tier: nxt.tier as 1 | 2 | 3, weekIndex: nxt.weekIndex, nowMs: then });
    expect(back.cosmeticsAlreadyOwned).toContain(firstId);
    // payload.cosmetics lists every OFFERED id, the already-owned one included.
    expect(back.events[0]!.payload["cosmetics"]).toEqual(back.offer.cosmetics.map((c) => c.id));
    const events = (await eventsOf(a)).filter((e) => e.event_type === "coin_purchased").sort((x, y) => x.seq - y.seq);
    const rebuilt = new Map<string, string>();
    for (const e of events) for (const id of e.payload["cosmetics"] as string[]) if (!rebuilt.has(id)) rebuilt.set(id, e.causation_id);
    const rows = await pool.query<{ cosmetic_id: string; causation_id: string }>(
      "SELECT o.cosmetic_id, p.causation_id FROM cosmetic_ownership o JOIN pack_purchase p ON p.id = o.purchase_id WHERE o.account_id = $1",
      [a],
    );
    const stored = new Map(rows.rows.map((r) => [r.cosmetic_id, r.causation_id]));
    expect(rebuilt).toEqual(stored);
    expect(stored.size).toBe(6 + back.cosmeticsGranted.length);
    const src = readFileSync(join(SERVER, "src", "store", "purchase.ts"), "utf8");
    expect(src).toMatch(/payload\.cosmetics`[\s*]+lists the cosmetic ids the pack OFFERED/);
    expect(src).toMatch(/the FIRST `coin_purchased` event \(in[\s*]+ledger order\) naming an id owns it/);
  });
});

describe("probe P2 / P4 / P5", () => {
  it("P2: preview at endsAt − 1, purchase at endsAt naming the old week → 409 offer_not_current, no event", async () => {
    const a = await fresh("p2");
    const b = weekBounds(WEEK);
    const v = await storeView(pool, a, b.endsAtMs - 1);
    expect(v.week.index).toBe(WEEK);
    const e = await appErr(purchasePack(pool, { accountId: a, tier: 2, weekIndex: v.week.index, nowMs: b.endsAtMs, contentsHash: v.offers[1]!.contentsHash }));
    expect([e.statusCode, e.code]).toEqual([409, "offer_not_current"]);
    expect((await eventsOf(a)).filter((x) => x.event_type === "coin_purchased" || x.payload["reason"] === "trickle")).toEqual([]);
  });

  it("P4: a unit skin for another region's type can be equipped — cosmetics are account-level, not caravan-level", async () => {
    const a = await fresh("p4");
    const id = "skin.mountain.grizzly.cinnamon";
    const nxt = cosmeticOfferWeeks(id, WEEK, 520)[0]!;
    const then = NOW + (nxt.weekIndex - WEEK) * PERIOD;
    await purchasePack(pool, { accountId: a, tier: nxt.tier as 1 | 2 | 3, weekIndex: nxt.weekIndex, nowMs: then });
    expect(await equipCosmetic(pool, a, id)).toMatchObject({ slot: "unit_skin:mountain.grizzly", cosmeticId: id });
  });

  it("P5: malformed purchase bodies are 400s with a code, never a 500; tier 2.0 is tier 2", async () => {
    const a = await fresh("p5");
    const { token } = await issueSession(pool, a);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const view = await storeView(pool, a, Date.now());
    const h = (t: 1 | 2 | 3) => view.offers[t - 1]!.contentsHash;
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/me/store/purchase", headers, payload: payload as string });
    const cases: [string, unknown, number, string][] = [
      ["null", "null", 400, "contents_hash_required"],
      ["string", '"abc"', 400, "contents_hash_required"],
      ["float week", { tier: 1, weekIndex: WEEK + 0.5, contentsHash: h(1) }, 400, "invalid_week"],
      ["huge week", { tier: 1, weekIndex: 1e20, contentsHash: h(1) }, 400, "invalid_week"],
      ["neg tier", { tier: -1, weekIndex: WEEK, contentsHash: h(1) }, 400, "invalid_tier"],
      ["string tier", { tier: "1", weekIndex: WEEK, contentsHash: h(1) }, 400, "invalid_tier"],
      ["hash null", { tier: 1, weekIndex: WEEK, contentsHash: null }, 400, "invalid_contents_hash"],
    ];
    for (const [name, payload, status, code] of cases) {
      const res = await post(payload);
      expect([res.statusCode, res.json().error], name).toEqual([status, code]);
    }
    const noBody = await app.inject({ method: "POST", url: "/me/store/purchase", headers: { authorization: headers.authorization } });
    expect(noBody.statusCode).toBe(400);
    expect((await post("{not json")).statusCode).toBe(400);
    const two = await post(JSON.stringify({ tier: 2.0, weekIndex: WEEK, contentsHash: h(2) }));
    expect(two.statusCode).toBe(201);
    expect(two.json().purchase.tier).toBe(2);
    expect((await readCoinBalance(pool, a)).balance).toBe(14_000);
  });
});
