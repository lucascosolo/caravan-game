/**
 * Fixtures for the Packs and Cosmetics component tests (chunk 20 web), shaped like the
 * server's `GET /me/store` / `GET /me/cosmetics` bodies and run through the client's own
 * guards (storeShapes.test.ts) so they cannot drift from what the client accepts.
 */
import type { CosmeticInfoView, CosmeticsView, OwnedCosmeticView, PackOfferBaseView, PackOfferView, PackTierView, PurchaseResult, StoreOverflowView, StoreView } from "../api/types.ts";

export const WEEK = 39;
const WEEK_MS = 7 * 86_400_000;
const EPOCH = 1_767_571_200_000; // 2026-01-05T00:00Z, week 0
export const weekStart = (w: number): number => EPOCH + w * WEEK_MS;

const note = "Palette only. — pending art review (chunk 26)";

export const COSMETICS: Readonly<Record<string, CosmeticInfoView>> = {
  "fence_style.weathered_grey": { id: "fence_style.weathered_grey", kind: "fence_style", displayName: "Weathered Grey", description: "Sun-greyed timber.", appliesTo: null, reviewNote: note, slot: "fence_style" },
  "skin.desert.dust_rider.sunbleached": {
    id: "skin.desert.dust_rider.sunbleached",
    kind: "unit_skin",
    displayName: "Sunbleached Dust Rider",
    description: "Faded duster and a straw hat.",
    appliesTo: "desert.dust_rider",
    reviewNote: note,
    slot: "unit_skin:desert.dust_rider",
  },
  "town.water_tower": { id: "town.water_tower", kind: "town_decoration", displayName: "Water Tower", description: "A wooden tower by the mine.", appliesTo: null, reviewNote: note, slot: "town_decoration" },
  "wagon.circus_stripe": { id: "wagon.circus_stripe", kind: "wagon_skin", displayName: "Circus Stripe", description: "Red and gold striped canopy.", appliesTo: null, reviewNote: note, slot: "wagon_skin" },
  "banner.lone_star": { id: "banner.lone_star", kind: "party_banner", displayName: "Lone Star", description: "A single white star on blue.", appliesTo: null, reviewNote: note, slot: "party_banner" },
  "skin.high_plains.homesteader.calico": {
    id: "skin.high_plains.homesteader.calico",
    kind: "unit_skin",
    displayName: "Calico Homesteader",
    description: "Patched calico shirt.",
    appliesTo: "high_plains.homesteader",
    reviewNote: note,
    slot: "unit_skin:high_plains.homesteader",
  },
  "wagon.conestoga_white": { id: "wagon.conestoga_white", kind: "wagon_skin", displayName: "Whitetop Conestoga", description: "Bleached canvas over a blue bed.", appliesTo: null, reviewNote: note, slot: "wagon_skin" },
  "fence_style.painted_red": { id: "fence_style.painted_red", kind: "fence_style", displayName: "Barn Red", description: "Red-painted rails.", appliesTo: null, reviewNote: note, slot: "fence_style" },
};

const PRICE: Record<PackTierView, [number, string, number]> = { 1: [500, "$5", 6000], 2: [1000, "$10", 14000], 3: [2500, "$25", 40000] };
const THIS_WEEK: Record<PackTierView, string[]> = {
  1: ["fence_style.weathered_grey"],
  2: ["skin.desert.dust_rider.sunbleached", "town.water_tower"],
  3: ["wagon.circus_stripe", "banner.lone_star", "skin.high_plains.homesteader.calico"],
};
const NEXT_WEEK: Record<PackTierView, string[]> = { 1: ["wagon.conestoga_white"], 2: ["town.water_tower", "fence_style.painted_red"], 3: ["banner.lone_star", "wagon.circus_stripe", "fence_style.weathered_grey"] };

export const hashOf = (seed: string): string => {
  let h = "";
  for (let i = 0; h.length < 64; i++) h += ((seed.charCodeAt(i % seed.length) + i) % 16).toString(16);
  return h;
};

export function overflowFor(balance: number, cap: number, coin: number): StoreOverflowView {
  const room = Math.max(0, cap - balance);
  const wouldCredit = Math.min(coin, room);
  const wouldDiscard = coin - wouldCredit;
  return {
    balance,
    cap,
    room,
    prospectiveEarn: coin,
    wouldCredit,
    wouldDiscard,
    atCap: room === 0,
    warn: wouldDiscard > 0,
    message:
      wouldDiscard > 0
        ? `Your store has room for ${room} more Coin right now; ${wouldDiscard} of the ${coin} Coin in this purchase would be discarded at the cap.`
        : `Your store has room for ${room} more Coin right now; all ${coin} Coin would be credited.`,
  };
}

export function offerBase(week: number, tier: PackTierView, ids: readonly string[], hashSeed = ""): PackOfferBaseView {
  const [priceCents, priceDisplay, coin] = PRICE[tier];
  return {
    id: `pack:w${week}:t${tier}`,
    weekIndex: week,
    tier,
    priceCents,
    priceDisplay,
    coin,
    cosmetics: ids.map((id) => COSMETICS[id]!),
    contents: [{ kind: "coin", amount: coin }, ...ids.map((cosmeticId) => ({ kind: "cosmetic" as const, cosmeticId }))],
    contentsHash: hashOf(`w${week}t${tier}${ids.join("|")}${hashSeed}`),
  };
}

export interface StoreOpts {
  readonly balance?: number;
  readonly cap?: number;
  readonly purchased?: readonly PackTierView[];
  /** Replace a tier's cosmetics this week (the offer_changed path). */
  readonly swap?: Partial<Record<PackTierView, readonly string[]>>;
  readonly week?: number;
  /** Final review D1: STORE_MODE (default sandbox). */
  readonly mode?: "sandbox" | "off";
}

export function storeView(opts: StoreOpts = {}): StoreView {
  const balance = opts.balance ?? 1000;
  const cap = opts.cap ?? 50_000;
  const week = opts.week ?? WEEK;
  const bought = new Set(opts.purchased ?? []);
  const offers: PackOfferView[] = ([1, 2, 3] as const).map((tier) => ({
    ...offerBase(week, tier, opts.swap?.[tier] ?? THIS_WEEK[tier]),
    purchased: bought.has(tier),
    purchasedAt: bought.has(tier) ? "2026-10-11T12:00:00.000Z" : null,
    purchaseId: bought.has(tier) ? `00000000-0000-4000-8000-00000000000${tier}` : null,
    overflow: overflowFor(balance, cap, PRICE[tier][2]),
  }));
  const open = offers.filter((o) => !o.purchased);
  const combinedCoin = open.reduce((a, o) => a + o.coin, 0);
  return {
    mode: opts.mode ?? "sandbox",
    backend: { name: "sandbox_stub", sandbox: true, realCharges: false, message: "SANDBOX STUB: purchases record the grant and charge nothing. Real payment integration is not part of this build." },
    week: { index: week, startsAtMs: weekStart(week), endsAtMs: weekStart(week + 1), nowMs: weekStart(week) + 3_600_000 },
    balance: { balance, cap, room: Math.max(0, cap - balance), atCap: balance >= cap, pendingTrickle: 0 },
    offers,
    combined: { tiers: open.map((o) => o.tier), coin: combinedCoin, overflow: overflowFor(balance, cap, combinedCoin) },
    upcoming: [{ weekIndex: week + 1, startsAtMs: weekStart(week + 1), endsAtMs: weekStart(week + 2), offers: ([1, 2, 3] as const).map((t) => offerBase(week + 1, t, NEXT_WEEK[t])) }],
    ceiling: {
      weeklyPayCeiling: 60_000,
      freeWeeklyEarnEstimate: 40_000,
      paidToFreeRatioBp: 15_000,
      paidToFreeRatioMaxBp: 15_000,
      storageCap: 50_000,
      purchaseLimitPerTierPerWeek: 1,
      note: "All three tiers stack in one week, each once; the pay-to-accelerate ceiling is their combined Coin, which exceeds the storage cap.",
    },
  };
}

export function purchaseResult(offer: PackOfferBaseView, opts: { readonly replayed?: boolean; readonly balanceBefore?: number; readonly cap?: number } = {}): PurchaseResult {
  const before = opts.balanceBefore ?? 1000;
  const cap = opts.cap ?? 50_000;
  const credited = Math.min(offer.coin, Math.max(0, cap - before));
  const ids = offer.cosmetics.map((c) => c.id);
  return {
    sandbox: true,
    replayed: opts.replayed ?? false,
    purchase: {
      id: "00000000-0000-4000-8000-000000000001",
      weekIndex: offer.weekIndex,
      tier: offer.tier,
      backend: "sandbox_stub",
      sandboxReceipt: "sandbox:00000000-0000-4000-8000-000000000002",
      priceCents: offer.priceCents,
      contents: offer.contents,
      coin: { requested: offer.coin, credited, discarded: offer.coin - credited },
      purchasedAt: "2026-10-11T12:00:00.000Z",
      settled: true,
    },
    coin: { requested: offer.coin, credited, discarded: offer.coin - credited, balanceAfter: before + credited, cap },
    cosmeticsGranted: ids,
    cosmeticsAlreadyOwned: [],
  };
}

export function owned(id: string, equipped = false): OwnedCosmeticView {
  return { ...COSMETICS[id]!, purchaseId: "00000000-0000-4000-8000-000000000001", grantedAt: "2026-10-11T12:00:00.000Z", equipped };
}

export function cosmeticsView(ownedIds: readonly string[] = [], equipped: Readonly<Record<string, string>> = {}): CosmeticsView {
  const on = new Set(Object.values(equipped));
  return {
    kinds: ["unit_skin", "wagon_skin", "fence_style", "town_decoration", "party_banner"],
    owned: ownedIds.map((id) => owned(id, on.has(id))),
    equipped,
    catalog: Object.values(COSMETICS).map((c) => ({ ...c, owned: ownedIds.includes(c.id), nextOffer: { weekIndex: WEEK + 2, tier: 2 as const } })),
  };
}
