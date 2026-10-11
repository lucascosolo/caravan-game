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
  REVIEW_PENDING_MARKER,
  TUNABLES,
  assertCosmeticsValid,
  assertPacksValid,
  canonicalPackContents,
  cosmeticEquipSlot,
  cosmeticOfferWeeks,
  cosmeticRotationForWeek,
  cosmeticRotationOver,
  formatPriceCents,
  getCosmeticType,
  isDeepFrozen,
  isPackContentKind,
  isPackTier,
  packOfferForWeek,
  packOffersForWeek,
  reviewNoteIsWellFormed,
  rotationRank,
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

  it("the assumed free-vs-paid ratio is written down and within the bound (≈ 1.09× the derived mid week at the defaults)", () => {
    // Chunk 19 QA D3: the MID value of the re-derived range (≈ 43.7k / 55.5k / 66.7k), rounded
    // down; the server's stakes test pins it to scripts/balance/model.ts weeklyFreeEarn.
    expect(TUNABLES.FREE_WEEKLY_EARN_ESTIMATE).toBe(55_000);
    expect(TUNABLES.PAID_TO_FREE_RATIO_MAX_BP).toBe(15_000);
    // 60,000 / 55,000 ≈ 1.09, cross-multiplied: inside the 1.5× bound.
    expect(TUNABLES.WEEKLY_PAY_CEILING * 10_000).toBeLessThan(TUNABLES.FREE_WEEKLY_EARN_ESTIMATE * 15_000);
    expect(Math.floor((TUNABLES.WEEKLY_PAY_CEILING * 10_000) / TUNABLES.FREE_WEEKLY_EARN_ESTIMATE)).toBe(10_909);
    expect(TUNABLES.WEEKLY_PAY_CEILING * 10_000).toBeLessThanOrEqual(TUNABLES.FREE_WEEKLY_EARN_ESTIMATE * TUNABLES.PAID_TO_FREE_RATIO_MAX_BP);
    // The comment a balancer will find: the estimate's derivation sits next to the number.
    const src = readFileSync(join(HERE, "..", "src", "tunables.ts"), "utf8");
    expect(src).toMatch(/FREE_WEEKLY_EARN_ESTIMATE: 55_000/);
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

  it("the rotation is pinned: week 0 is these exact ids (changing the draw is a visible diff)", () => {
    // Pinned so a refactor of the draw cannot silently re-deal a past week (a stored purchase
    // names the week it was bought in). DELIBERATELY RE-PINNED for QA-20 S2 (2026-10-11): the
    // draw moved from a seeded Fisher–Yates over the whole catalog to a per-cosmetic rank,
    // hash(week, id), so that a catalog addition never reshuffles existing weeks. The
    // previous pin was [whitewashed], [grizzly.cinnamon, tarred_black], [weathered_grey,
    // circus_stripe, trapper.beaver_hat]. No purchase had been made under the old draw
    // (sandbox only, pre-release), so nothing stored names a cosmetic it no longer matches.
    expect(cosmeticRotationForWeek(0)).toEqual([
      ["fence_style.tarred_black"],
      ["skin.desert.well_digger.copper", "banner.rattlesnake_coil"],
      ["fence_style.whitewashed", "skin.badlands.bounty_hunter.tin_star", "banner.crossed_pickaxes"],
    ]);
    expect(cosmeticRotationForWeek(1).flat()).toHaveLength(6);
  });

  it("QA-20 S2: the draw is per cosmetic — adding or removing a catalog entry never changes the relative order of the others, in any week", () => {
    const ids = COSMETIC_TYPES.map((c) => c.id);
    const order = (deal: readonly (readonly string[])[]) => deal.flat();
    for (let w = -2; w < 120; w++) {
      const full = order(cosmeticRotationOver(ids, w));
      // Remove each id in turn: the remaining ids keep their relative order (a new entry is the
      // same experiment read backwards).
      for (const gone of ids) {
        const without = order(cosmeticRotationOver(ids.filter((x) => x !== gone), w));
        // `full` is only the dealt six, so compare the prefix those six determine: the
        // survivors, in the same order, followed (when `gone` was dealt) by one newcomer.
        const expected = full.filter((x) => x !== gone);
        expect(without.slice(0, expected.length), `week ${w} without ${gone}`).toEqual(expected);
      }
      // Add a hypothetical new entry: everyone else keeps their relative order.
      const plus = order(cosmeticRotationOver([...ids, "zz.hypothetical.new_entry"], w));
      expect(plus.filter((x) => x !== "zz.hypothetical.new_entry")).toEqual(full.slice(0, plus.filter((x) => x !== "zz.hypothetical.new_entry").length));
      // And a rank is a pure function of (week, id): same inputs, same number, 32-bit unsigned.
      for (const id of ids.slice(0, 3)) {
        const r = rotationRank(w, id);
        expect(r).toBe(rotationRank(w, id));
        expect(Number.isInteger(r) && r >= 0 && r < 0x1_0000_0000).toBe(true);
      }
    }
    // The ranks differ by week for the same id (it rotates) and by id for the same week.
    expect(rotationRank(0, ids[0]!)).not.toBe(rotationRank(1, ids[0]!));
    expect(rotationRank(0, ids[0]!)).not.toBe(rotationRank(0, ids[1]!));
  });

  it("QA-20 S2: canonicalPackContents is a fixed-key-order, whitespace-free text of the exact granted list", () => {
    const o = packOfferForWeek(0, 2);
    const text = canonicalPackContents(o.contents);
    expect(text).toBe(`[{"kind":"coin","amount":14000},{"kind":"cosmetic","cosmeticId":"${o.cosmetics[0]!.id}"},{"kind":"cosmetic","cosmeticId":"${o.cosmetics[1]!.id}"}]`);
    expect(JSON.parse(text)).toEqual(o.contents);
    // Key order in the input does not matter; order of entries does.
    expect(canonicalPackContents([{ cosmeticId: "a", kind: "cosmetic" } as never, { amount: 1, kind: "coin" } as never])).toBe('[{"kind":"cosmetic","cosmeticId":"a"},{"kind":"coin","amount":1}]');
    expect(canonicalPackContents([...o.contents].reverse())).not.toBe(text);
    expect(() => canonicalPackContents([{ kind: "coin", amount: 1.5 }])).toThrow(RangeError);
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

  it("QA-20 N4: isPackTier is integer equality on purpose — 2.0 is 2, nothing else coerces", () => {
    expect(isPackTier(2.0)).toBe(true);
    for (const v of ["2", 2.5, 0, 4, -1, NaN, true, null, undefined, [2], { tier: 2 }]) expect(isPackTier(v), String(v)).toBe(false);
  });

  it("QA-20 N2: every review note names its reviewer and date, or says plainly that the art review is pending (chunk 26)", () => {
    for (const c of COSMETIC_TYPES) {
      expect(reviewNoteIsWellFormed(c.reviewNote), c.id).toBe(true);
      // Nothing in this build has been reviewed against art yet: every note carries the marker.
      expect(c.reviewNote, c.id).toContain(REVIEW_PENDING_MARKER);
      expect(c.reviewNote, c.id).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    expect(reviewNoteIsWellFormed("Palette only. (reviewed by A. Reviewer, 2026-11-02)")).toBe(true);
    expect(reviewNoteIsWellFormed("Palette only; identifiable at scouting zoom.")).toBe(false);
    expect(reviewNoteIsWellFormed("reviewed by someone, sometime")).toBe(false);
  });

  it("ids are unique and sorted, and the equip slot is per unit type for skins and per kind otherwise", () => {
    const ids = COSMETIC_TYPES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(cosmeticEquipSlot(getCosmeticType("skin.desert.dust_rider.sunbleached")!)).toBe("unit_skin:desert.dust_rider");
    expect(cosmeticEquipSlot(getCosmeticType("banner.lone_star")!)).toBe("party_banner");
  });
});
