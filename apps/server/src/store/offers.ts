/**
 * The storefront view (chunk 20): what is on offer this week, what was already bought, and
 * — before any purchase — exactly what each tier would do to the balance.
 *
 * Legibility (GUARDRAILS §4): every number here is the number the purchase will record.
 * The Coin amounts come from the registry and never vary; the cosmetics come from the
 * deterministic rotation in @caravan/content (identical for every player; next week is
 * shown too); the overflow forecast is chunk 16's `overflowForecast` over the balance
 * INCLUDING the trickle pending right now (read-only `peekTrickle`, QA-16 S2), because
 * WEEKLY_PAY_CEILING (60,000) exceeds COIN_STORAGE_CAP (50,000): a player who buys more
 * than the store can hold is told what the cap will discard before paying (QA-16 note).
 *
 * The wall clock enters in exactly one place: `nowMs`, which decides WHICH week it is.
 * Everything else is a pure function of the week index.
 */
import {
  TUNABLES,
  cosmeticOfferWeeks,
  packOffersForWeek,
  weekBounds,
  weekIndexAt,
  weeklyPayCeiling,
  type CosmeticType,
  type PackContent,
  type PackOffer,
  type PackTier,
} from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import { overflowForecast, type OverflowForecast } from "../economy/coin.js";
import { peekTrickle } from "../economy/trickle.js";

/** How many weeks ahead a cosmetic's "next on offer" is searched. Presentation, not balance. */
export const COSMETIC_SCHEDULE_HORIZON_WEEKS = 52;

export interface CosmeticView {
  id: string;
  kind: CosmeticType["kind"];
  displayName: string;
  description: string;
  appliesTo: string | null;
  reviewNote: string;
  /** The equip slot it would occupy. */
  slot: string;
}

export interface OverflowView extends OverflowForecast {
  warn: boolean;
  message: string;
}

export interface OfferView {
  id: string;
  weekIndex: number;
  tier: PackTier;
  priceCents: number;
  priceDisplay: string;
  /** Fixed week to week. */
  coin: number;
  cosmetics: CosmeticView[];
  /** The exact list the purchase grants. */
  contents: PackContent[];
  /** This account already bought this tier this week (each tier once per week). */
  purchased: boolean;
  purchasedAt: string | null;
  purchaseId: string | null;
  /** What crediting `coin` would do to the balance right now. */
  overflow: OverflowView;
}

export interface StoreView {
  backend: {
    name: string;
    sandbox: true;
    realCharges: false;
    message: string;
  };
  week: { index: number; startsAtMs: number; endsAtMs: number; nowMs: number };
  balance: { balance: number; cap: number; room: number; atCap: boolean; pendingTrickle: number };
  offers: OfferView[];
  /** All still-unpurchased tiers at once: the combined forecast, since tiers stack. */
  combined: { tiers: PackTier[]; coin: number; overflow: OverflowView };
  /** Next week(s): the same tiers, the rotation's cosmetics, no purchase state yet. */
  upcoming: { weekIndex: number; startsAtMs: number; endsAtMs: number; offers: Omit<OfferView, "purchased" | "purchasedAt" | "purchaseId" | "overflow">[] }[];
  ceiling: {
    /** THE P2W number: all three tiers combined. */
    weeklyPayCeiling: number;
    freeWeeklyEarnEstimate: number;
    paidToFreeRatioBp: number;
    paidToFreeRatioMaxBp: number;
    storageCap: number;
    purchaseLimitPerTierPerWeek: number;
    note: string;
  };
}

export function cosmeticView(c: CosmeticType): CosmeticView {
  return {
    id: c.id,
    kind: c.kind,
    displayName: c.displayName,
    description: c.description,
    appliesTo: c.appliesTo,
    reviewNote: c.reviewNote,
    slot: c.kind === "unit_skin" ? `unit_skin:${c.appliesTo}` : c.kind,
  };
}

export function overflowView(balance: number, cap: number, coin: number): OverflowView {
  const f = overflowForecast(balance, cap, coin);
  return {
    ...f,
    warn: f.wouldDiscard > 0,
    message:
      f.wouldDiscard > 0
        ? `Your store has room for ${f.room} more Coin right now; ${f.wouldDiscard} of the ${f.prospectiveEarn} Coin in this purchase would be discarded at the cap.`
        : `Your store has room for ${f.room} more Coin right now; all ${f.prospectiveEarn} Coin would be credited.`,
  };
}

function offerBase(o: PackOffer): Omit<OfferView, "purchased" | "purchasedAt" | "purchaseId" | "overflow"> {
  return {
    id: o.id,
    weekIndex: o.weekIndex,
    tier: o.tier,
    priceCents: o.priceCents,
    priceDisplay: o.priceDisplay,
    coin: o.coin,
    cosmetics: o.cosmetics.map(cosmeticView),
    contents: [...o.contents],
  };
}

export interface PurchaseRow {
  id: string;
  account_id: string;
  week_index: number;
  tier: number;
  backend: string;
  sandbox_receipt: string;
  price_cents: number;
  contents: PackContent[];
  coin_requested: number;
  coin_credited: number;
  coin_discarded: number;
  causation_id: string;
  purchased_at: Date;
}

export async function listPurchasesForWeek(db: Queryable, accountId: string, weekIndex: number): Promise<PurchaseRow[]> {
  const res = await db.query<PurchaseRow>("SELECT * FROM pack_purchase WHERE account_id = $1 AND week_index = $2 ORDER BY tier", [accountId, weekIndex]);
  return res.rows.map(normalizePurchaseRow);
}

export async function listPurchases(db: Queryable, accountId: string): Promise<PurchaseRow[]> {
  const res = await db.query<PurchaseRow>("SELECT * FROM pack_purchase WHERE account_id = $1 ORDER BY purchased_at, tier", [accountId]);
  return res.rows.map(normalizePurchaseRow);
}

/** pg returns bigint columns as strings; the amounts are safe integers by CHECK. */
export function normalizePurchaseRow(r: PurchaseRow): PurchaseRow {
  return { ...r, coin_requested: Number(r.coin_requested), coin_credited: Number(r.coin_credited), coin_discarded: Number(r.coin_discarded) };
}

export function purchaseView(r: PurchaseRow) {
  return {
    id: r.id,
    weekIndex: r.week_index,
    tier: r.tier,
    backend: r.backend,
    sandboxReceipt: r.sandbox_receipt,
    priceCents: r.price_cents,
    contents: r.contents,
    coin: { requested: r.coin_requested, credited: r.coin_credited, discarded: r.coin_discarded },
    causationId: r.causation_id,
    purchasedAt: r.purchased_at.toISOString(),
  };
}

/** The storefront as of `nowMs`. Read-only: nothing is written (the trickle is peeked, not materialized). */
export async function storeView(db: Queryable, accountId: string, nowMs: number): Promise<StoreView> {
  const weekIndex = weekIndexAt(nowMs);
  const bounds = weekBounds(weekIndex);
  const trickle = await peekTrickle(db, accountId, nowMs);
  const balance = trickle.balance;
  const cap = trickle.cap;
  const bought = new Map((await listPurchasesForWeek(db, accountId, weekIndex)).map((p) => [p.tier, p]));
  const offers: OfferView[] = packOffersForWeek(weekIndex).map((o) => {
    const p = bought.get(o.tier);
    return {
      ...offerBase(o),
      purchased: p !== undefined,
      purchasedAt: p ? p.purchased_at.toISOString() : null,
      purchaseId: p ? p.id : null,
      overflow: overflowView(balance, cap, o.coin),
    };
  });
  const open = offers.filter((o) => !o.purchased);
  const combinedCoin = open.reduce((a, o) => a + o.coin, 0);
  const upcoming = [];
  for (let w = weekIndex + 1; w <= weekIndex + TUNABLES.PACK_ROTATION_PREVIEW_WEEKS; w++) {
    const b = weekBounds(w);
    upcoming.push({ weekIndex: w, startsAtMs: b.startsAtMs, endsAtMs: b.endsAtMs, offers: packOffersForWeek(w).map(offerBase) });
  }
  const ceiling = weeklyPayCeiling();
  return {
    backend: {
      name: TUNABLES.PURCHASE_BACKEND,
      sandbox: true,
      realCharges: false,
      message: "SANDBOX STUB: purchases record the grant and charge nothing. Real payment integration is not part of this build.",
    },
    week: { index: weekIndex, startsAtMs: bounds.startsAtMs, endsAtMs: bounds.endsAtMs, nowMs },
    balance: { balance, cap, room: Math.max(0, cap - balance), atCap: trickle.atCap, pendingTrickle: trickle.pending },
    offers,
    combined: { tiers: open.map((o) => o.tier), coin: combinedCoin, overflow: overflowView(balance, cap, combinedCoin) },
    upcoming,
    ceiling: {
      weeklyPayCeiling: ceiling,
      freeWeeklyEarnEstimate: TUNABLES.FREE_WEEKLY_EARN_ESTIMATE,
      // Integer basis points, floored: 60,000 / 40,000 → 15,000 bp (1.5×).
      paidToFreeRatioBp: Math.floor((ceiling * 10_000) / TUNABLES.FREE_WEEKLY_EARN_ESTIMATE),
      paidToFreeRatioMaxBp: TUNABLES.PAID_TO_FREE_RATIO_MAX_BP,
      storageCap: TUNABLES.COIN_STORAGE_CAP,
      purchaseLimitPerTierPerWeek: TUNABLES.PURCHASE_LIMIT_PER_TIER_PER_WEEK,
      note: "All three tiers stack in one week, each once; the pay-to-accelerate ceiling is their combined Coin, which exceeds the storage cap.",
    },
  };
}

/** When a cosmetic is next on offer from `fromWeek` (inclusive), within the horizon. */
export function nextOffer(cosmeticId: string, fromWeek: number): { weekIndex: number; tier: number } | null {
  return cosmeticOfferWeeks(cosmeticId, fromWeek, COSMETIC_SCHEDULE_HORIZON_WEEKS)[0] ?? null;
}
