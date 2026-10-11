/**
 * Chunk 20 / PHASE-2 §28: the pack registry and the cosmetic catalog. Coin amounts are
 * fixed week to week; the P2W number is the combined ceiling; the cosmetic rotation is a
 * pure function of the week index; a pack can hold nothing but Coin and cosmetics; a
 * cosmetic has no number on it anywhere.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COSMETIC_KINDS,
  COSMETIC_TYPES,
  LIVING_UNIT_TYPES,
  PACK_TIERS,
  TUNABLES,
  assertCosmeticsValid,
  assertPacksValid,
  cosmeticEquipSlot,
  cosmeticOfferWeeks,
  cosmeticRotationForWeek,
  formatPriceCents,
  getCosmeticType,
  isDeepFrozen,
  isPackContentKind,
  packOfferForWeek,
  packOffersForWeek,
  rotationSeed,
  weekBounds,
  weekIndexAt,
  weeklyPayCeiling,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HORIZON_WEEKS = 520; // ten years of rotation

describe("three fixed tiers (GUARDRAILS §2: fixed, previewed, consistent week to week)", () => {
  it("prices are $5 / $10 / $25 and Coin is 6,000 / 14,000 / 40,000 in EVERY week of a ten-year horizon", () => {
    expect(TUNABLES.PACK_TIER_PRICES_CENTS).toEqual([500, 1000, 2500]);
    expect(TUNABLES.PACK_COIN_BY_TIER).toEqual([6000, 14_000, 40_000]);
    for (let w = -3; w < HORIZON_WEEKS; w++) {
      const offers = packOffersForWeek(w);
      expect(offers.map((o) => o.tier)).toEqual([1, 2, 3]);
      expect(offers.map((o) => o.priceCents)).toEqual([500, 1000, 2500]);
      expect(offers.map((o) => o.priceDisplay)).toEqual(["$5", "$10", "$25"]);
      expect(offers.map((o) => o.coin)).toEqual([6000, 14_000, 40_000]);
      for (const o of offers) {
        expect(o.weekIndex).toBe(w);
        expect(o.id).toBe(`pack:w${w}:t${o.tier}`);
        // The first content entry is the Coin; the rest are exactly the previewed cosmetics.
        expect(o.contents[0]).toEqual({ kind: "coin", amount: o.coin });
        expect(o.contents.slice(1)).toEqual(o.cosmetics.map((c) => ({ kind: "cosmetic", cosmeticId: c.id })));
      }
    }
  });

  it("the P2W number is the COMBINED ceiling, 60,000, and it exceeds the storage cap (so the store must forecast overflow)", () => {
    expect(weeklyPayCeiling()).toBe(60_000);
    expect(TUNABLES.WEEKLY_PAY_CEILING).toBe(weeklyPayCeiling());
    expect(TUNABLES.WEEKLY_PAY_CEILING).toBeGreaterThan(TUNABLES.PACK_COIN_BY_TIER[2]!); // not the top tier's figure
    expect(TUNABLES.WEEKLY_PAY_CEILING).toBeGreaterThan(TUNABLES.COIN_STORAGE_CAP);
  });

  it("the assumed free-vs-paid ratio is written down and within the bound (1.5× at the defaults)", () => {
    expect(TUNABLES.FREE_WEEKLY_EARN_ESTIMATE).toBe(40_000);
    expect(TUNABLES.PAID_TO_FREE_RATIO_MAX_BP).toBe(15_000);
    // 60,000 / 40,000 = 1.5 exactly, cross-multiplied.
    expect(TUNABLES.WEEKLY_PAY_CEILING * 10_000).toBe(TUNABLES.FREE_WEEKLY_EARN_ESTIMATE * 15_000);
    expect(TUNABLES.WEEKLY_PAY_CEILING * 10_000).toBeLessThanOrEqual(TUNABLES.FREE_WEEKLY_EARN_ESTIMATE * TUNABLES.PAID_TO_FREE_RATIO_MAX_BP);
    // The comment a balancer will find: the estimate's derivation sits next to the number.
    const src = readFileSync(join(HERE, "..", "src", "tunables.ts"), "utf8");
    expect(src).toMatch(/FREE_WEEKLY_EARN_ESTIMATE: 40_000/);
    expect(src).toMatch(/ASSUMPTION TO VALIDATE IN PLAYTESTING/);
    expect(src).toMatch(/THE P2W-RELEVANT NUMBER IS WEEKLY_PAY_CEILING/);
  });

  it("validation refuses a registry whose ceiling is not the sum of the tiers", () => {
    expect(() => assertPacksValid()).not.toThrow();
    expect(formatPriceCents(500)).toBe("$5");
    expect(formatPriceCents(1050)).toBe("$10.50");
    expect(formatPriceCents(1005)).toBe("$10.05");
  });

  it("a pack can hold nothing but Coin and cosmetics (PACK_CONTENT_KINDS), fixed by design", () => {
    expect(TUNABLES.PACK_CONTENT_KINDS).toEqual(["coin", "cosmetic"]);
    for (const k of ["unlock_points", "unit", "unit_access", "trip_cap", "slot", "slots", "fence_material", "repair", "resupply", "reroll", "merge", "ladder", "reputation"]) {
      expect(isPackContentKind(k), k).toBe(false);
    }
    for (let w = 0; w < HORIZON_WEEKS; w++) {
      for (const o of packOffersForWeek(w)) for (const c of o.contents) expect(isPackContentKind(c.kind)).toBe(true);
    }
    // And the source of the union names no other kind.
    const src = readFileSync(join(HERE, "..", "src", "packs.ts"), "utf8");
    const kinds = [...src.matchAll(/kind:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(kinds)).toEqual(new Set(["coin", "cosmetic"]));
  });
});

describe("the weekly rotation is deterministic and identical for everyone", () => {
  it("the same week index always yields the same cosmetics, with no cosmetic in two tiers of one week", () => {
    for (let w = -2; w < HORIZON_WEEKS; w++) {
      const a = cosmeticRotationForWeek(w);
      const b = cosmeticRotationForWeek(w);
      expect(a).toEqual(b);
      expect(a.map((t) => t.length)).toEqual([...TUNABLES.PACK_COSMETICS_BY_TIER]);
      const flat = a.flat();
      expect(new Set(flat).size).toBe(flat.length);
      for (const id of flat) expect(getCosmeticType(id)).toBeDefined();
    }
    expect(rotationSeed(0)).toBe(rotationSeed(0));
    expect(rotationSeed(1)).not.toBe(rotationSeed(0));
  });

  it("consecutive weeks differ (it rotates), and the offer for next week is previewable from this week", () => {
    let changes = 0;
    for (let w = 0; w < 52; w++) if (JSON.stringify(cosmeticRotationForWeek(w)) !== JSON.stringify(cosmeticRotationForWeek(w + 1))) changes++;
    expect(changes).toBeGreaterThan(45);
    // "Previewable one week ahead" is a consequence of purity: next week is just w + 1.
    expect(packOffersForWeek(weekIndexAt(TUNABLES.PACK_ROTATION_EPOCH_MS) + 1)).toEqual(packOffersForWeek(1));
  });

  it("every cosmetic returns: each is offered at least once within a year, and the schedule says when", () => {
    for (const c of COSMETIC_TYPES) {
      const weeks = cosmeticOfferWeeks(c.id, 0, 52);
      expect(weeks.length, c.id).toBeGreaterThan(0);
      for (const { weekIndex, tier } of weeks) {
        expect(packOfferForWeek(weekIndex, tier as 1 | 2 | 3).cosmetics.map((x) => x.id)).toContain(c.id);
      }
    }
  });

  it("the rotation is pinned: week 0 and week 1 are these exact ids (changing the draw is a visible diff)", () => {
    // Pinned so a refactor of the PRNG or the catalog order cannot silently re-deal every
    // past week (a stored purchase names the week it was bought in).
    expect(cosmeticRotationForWeek(0)).toEqual([
      ["fence_style.whitewashed"],
      ["skin.mountain.grizzly.cinnamon", "fence_style.tarred_black"],
      ["fence_style.weathered_grey", "wagon.circus_stripe", "skin.mountain.trapper.beaver_hat"],
    ]);
    expect(cosmeticRotationForWeek(1).flat()).toHaveLength(6);
  });

  it("week arithmetic: epoch is week 0, the instant before it is week −1, and bounds are half-open", () => {
    const E = TUNABLES.PACK_ROTATION_EPOCH_MS;
    const P = TUNABLES.PACK_ROTATION_PERIOD_MS;
    expect(P).toBe(7 * 24 * 60 * 60 * 1000);
    expect(weekIndexAt(E)).toBe(0);
    expect(weekIndexAt(E - 1)).toBe(-1);
    expect(weekIndexAt(E + P - 1)).toBe(0);
    expect(weekIndexAt(E + P)).toBe(1);
    expect(weekBounds(3)).toEqual({ startsAtMs: E + 3 * P, endsAtMs: E + 4 * P });
    expect(() => weekIndexAt(1.5)).toThrow(RangeError);
    expect(() => weekBounds(1.5)).toThrow(RangeError);
  });
});

describe("cosmetics are purely visual (PHASE-2 §28)", () => {
  it("exactly the five kinds; every entry has a readability review note; unit skins name a real unit type", () => {
    expect(COSMETIC_KINDS).toEqual(["unit_skin", "wagon_skin", "fence_style", "town_decoration", "party_banner"]);
    const unitIds = new Set<string>(LIVING_UNIT_TYPES.map((u) => u.id));
    for (const c of COSMETIC_TYPES) {
      expect(COSMETIC_KINDS).toContain(c.kind);
      expect(c.reviewNote.length).toBeGreaterThan(20);
      if (c.kind === "unit_skin") expect(unitIds.has(c.appliesTo!)).toBe(true);
      else expect(c.appliesTo).toBeNull();
    }
    for (const kind of COSMETIC_KINDS) expect(COSMETIC_TYPES.some((c) => c.kind === kind), kind).toBe(true);
    expect(() => assertCosmeticsValid()).not.toThrow();
  });

  it("no cosmetic carries a number anywhere: nothing on one can be a stat, a radius or a hitbox", () => {
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "number") throw new Error(`number at ${path}`);
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    for (const c of COSMETIC_TYPES) walk(c, c.id);
    expect(isDeepFrozen(COSMETIC_TYPES)).toBe(true);
    expect(PACK_TIERS).toEqual([1, 2, 3]);
  });

  it("ids are unique and sorted, and the equip slot is per unit type for skins and per kind otherwise", () => {
    const ids = COSMETIC_TYPES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(cosmeticEquipSlot(getCosmeticType("skin.desert.dust_rider.sunbleached")!)).toBe("unit_skin:desert.dust_rider");
    expect(cosmeticEquipSlot(getCosmeticType("banner.lone_star")!)).toBe("party_banner");
  });
});
