/**
 * Monetization packs (chunk 20): what the store offers in a given week. Pure functions over
 * the registry and the cosmetic catalog — the server's storefront reads from here and
 * nothing else, so what is previewed is, by construction, what is granted.
 *
 * GUARDRAILS §2, in code:
 *   - A pack holds exactly two kinds of thing, Coin and cosmetics (PACK_CONTENT_KINDS). The
 *     `PackContent` union has no other member; the schema's CHECK on pack_purchase.contents
 *     refuses any other kind; a test greps for the forbidden vocabulary.
 *   - Coin amounts are fixed week to week (PACK_COIN_BY_TIER); only the cosmetics rotate.
 *   - THE P2W CEILING IS THE COMBINED SUM: `weeklyPayCeiling()` = sum of all three tiers =
 *     TUNABLES.WEEKLY_PAY_CEILING (60,000). Never reason about a single tier's figure.
 *   - The assumed free-vs-paid ratio is TUNABLES.FREE_WEEKLY_EARN_ESTIMATE vs the ceiling,
 *     bounded by PAID_TO_FREE_RATIO_MAX_BP; `assertPacksValid` checks it on load.
 *
 * No clock here: `weekIndexAt(nowMs)` takes the instant as an argument. The wall clock
 * decides only WHICH week it is; the contents of a week are a pure function of its index.
 */
import { COSMETIC_TYPES, cosmeticRotationForWeek, getCosmeticType, type CosmeticType } from "./cosmetics.js";
import { TUNABLES } from "./tunables.js";

export const PACK_TIERS = [1, 2, 3] as const;
export type PackTier = (typeof PACK_TIERS)[number];

export function isPackTier(value: unknown): value is PackTier {
  return value === 1 || value === 2 || value === 3;
}

/** THE ONLY content kinds. There is deliberately no third member of this union. */
export type PackContent =
  | { readonly kind: "coin"; readonly amount: number }
  | { readonly kind: "cosmetic"; readonly cosmeticId: string };

export type PackContentKind = PackContent["kind"];

export function isPackContentKind(value: unknown): value is PackContentKind {
  return typeof value === "string" && (TUNABLES.PACK_CONTENT_KINDS as readonly string[]).includes(value);
}

export interface PackOffer {
  readonly weekIndex: number;
  readonly tier: PackTier;
  /** Stable id for a week's offer of a tier, e.g. `pack:w104:t2`. */
  readonly id: string;
  readonly priceCents: number;
  /** e.g. "$5". Presentation of priceCents, integer arithmetic only. */
  readonly priceDisplay: string;
  /** Fixed week to week. */
  readonly coin: number;
  readonly cosmetics: readonly CosmeticType[];
  /** The exact list that is granted on purchase; previewed verbatim. */
  readonly contents: readonly PackContent[];
}

/** The week index containing `nowMs` (floor division; integer in, integer out). */
export function weekIndexAt(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs)) throw new RangeError(`nowMs must be a safe integer, got ${String(nowMs)}`);
  return Math.floor((nowMs - TUNABLES.PACK_ROTATION_EPOCH_MS) / TUNABLES.PACK_ROTATION_PERIOD_MS);
}

/** [startsAtMs, endsAtMs) of a week. */
export function weekBounds(weekIndex: number): { readonly startsAtMs: number; readonly endsAtMs: number } {
  if (!Number.isInteger(weekIndex)) throw new RangeError(`weekIndex must be an integer, got ${String(weekIndex)}`);
  const startsAtMs = TUNABLES.PACK_ROTATION_EPOCH_MS + weekIndex * TUNABLES.PACK_ROTATION_PERIOD_MS;
  return { startsAtMs, endsAtMs: startsAtMs + TUNABLES.PACK_ROTATION_PERIOD_MS };
}

export function formatPriceCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError("cents must be a non-negative integer");
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return rem === 0 ? `$${dollars}` : `$${dollars}.${rem < 10 ? "0" : ""}${rem}`;
}

export function packCoinForTier(tier: PackTier): number {
  return TUNABLES.PACK_COIN_BY_TIER[tier - 1]!;
}

export function packPriceCentsForTier(tier: PackTier): number {
  return TUNABLES.PACK_TIER_PRICES_CENTS[tier - 1]!;
}

/** One tier's offer in one week. Coin never depends on the week; the cosmetics do. */
export function packOfferForWeek(weekIndex: number, tier: PackTier): PackOffer {
  const cosmeticIds = cosmeticRotationForWeek(weekIndex)[tier - 1]!;
  const cosmetics = cosmeticIds.map((id) => {
    const c = getCosmeticType(id);
    if (!c) throw new Error(`rotation named unknown cosmetic ${id}`);
    return c;
  });
  const coin = packCoinForTier(tier);
  return {
    weekIndex,
    tier,
    id: `pack:w${weekIndex}:t${tier}`,
    priceCents: packPriceCentsForTier(tier),
    priceDisplay: formatPriceCents(packPriceCentsForTier(tier)),
    coin,
    cosmetics,
    contents: [{ kind: "coin", amount: coin }, ...cosmetics.map((c): PackContent => ({ kind: "cosmetic", cosmeticId: c.id }))],
  };
}

/** All three tiers for a week, tier 1 first. */
export function packOffersForWeek(weekIndex: number): readonly PackOffer[] {
  return PACK_TIERS.map((t) => packOfferForWeek(weekIndex, t));
}

/**
 * THE pay-to-win number: every tier in one week, combined. Equals
 * TUNABLES.WEEKLY_PAY_CEILING (validated below); read that constant when sizing anything.
 */
export function weeklyPayCeiling(): number {
  return TUNABLES.PACK_COIN_BY_TIER.reduce((a, b) => a + b, 0);
}

/** Registry and catalog invariants for the store. Called once at content load (index.ts). */
export function assertPacksValid(): void {
  const fail = (why: string): never => {
    throw new Error(`packs: ${why}`);
  };
  const prices = TUNABLES.PACK_TIER_PRICES_CENTS;
  const coin = TUNABLES.PACK_COIN_BY_TIER;
  const counts = TUNABLES.PACK_COSMETICS_BY_TIER;
  if (prices.length !== PACK_TIERS.length || coin.length !== PACK_TIERS.length || counts.length !== PACK_TIERS.length) {
    fail(`exactly ${PACK_TIERS.length} tiers: prices ${prices.length}, coin ${coin.length}, cosmetic counts ${counts.length}`);
  }
  for (let i = 0; i < PACK_TIERS.length; i++) {
    if (!Number.isSafeInteger(prices[i]) || prices[i]! <= 0) fail(`tier ${i + 1} price must be a positive integer number of cents`);
    if (!Number.isSafeInteger(coin[i]) || coin[i]! <= 0) fail(`tier ${i + 1} Coin must be a positive integer`);
    if (!Number.isSafeInteger(counts[i]) || counts[i]! < 0) fail(`tier ${i + 1} cosmetic count must be a non-negative integer`);
    if (i > 0 && !(prices[i]! > prices[i - 1]!)) fail("prices must rise by tier");
    if (i > 0 && !(coin[i]! > coin[i - 1]!)) fail("Coin must rise by tier");
  }
  if (weeklyPayCeiling() !== TUNABLES.WEEKLY_PAY_CEILING) {
    fail(`WEEKLY_PAY_CEILING (${TUNABLES.WEEKLY_PAY_CEILING}) must equal the sum of PACK_COIN_BY_TIER (${weeklyPayCeiling()}) — the P2W number is the COMBINED total`);
  }
  // Paying may not exceed PAID_TO_FREE_RATIO_MAX_BP × an active free week (cross-multiplied; no floats).
  if (TUNABLES.WEEKLY_PAY_CEILING * 10_000 > TUNABLES.FREE_WEEKLY_EARN_ESTIMATE * TUNABLES.PAID_TO_FREE_RATIO_MAX_BP) {
    fail(
      `WEEKLY_PAY_CEILING ${TUNABLES.WEEKLY_PAY_CEILING} exceeds ${TUNABLES.PAID_TO_FREE_RATIO_MAX_BP} bp of FREE_WEEKLY_EARN_ESTIMATE ${TUNABLES.FREE_WEEKLY_EARN_ESTIMATE}: re-check the free-vs-paid ratio`,
    );
  }
  if (TUNABLES.PURCHASE_LIMIT_PER_TIER_PER_WEEK !== 1) fail("PURCHASE_LIMIT_PER_TIER_PER_WEEK is fixed at 1 (the unique index assumes it)");
  if (TUNABLES.PACK_CONTENT_KINDS.length !== 2 || TUNABLES.PACK_CONTENT_KINDS[0] !== "coin" || TUNABLES.PACK_CONTENT_KINDS[1] !== "cosmetic") {
    fail("PACK_CONTENT_KINDS is fixed by design at ['coin', 'cosmetic']");
  }
  if (TUNABLES.PACK_ROTATION_PERIOD_MS <= 0 || !Number.isSafeInteger(TUNABLES.PACK_ROTATION_PERIOD_MS)) fail("PACK_ROTATION_PERIOD_MS must be a positive integer");
  if (!Number.isSafeInteger(TUNABLES.PACK_ROTATION_EPOCH_MS)) fail("PACK_ROTATION_EPOCH_MS must be a safe integer");
  const perWeek = counts.reduce((a, b) => a + b, 0);
  if (COSMETIC_TYPES.length < perWeek) fail(`a week offers ${perWeek} cosmetics but the catalog holds ${COSMETIC_TYPES.length}`);
}
