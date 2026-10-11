/**
 * The store and cosmetics guards (chunk 20 web). The recorded server bodies pass them
 * (src/test/contract); these are the refusals that make the guards a legibility check and
 * not just a type check: a storefront whose headline disagrees with what the purchase grants,
 * a content kind other than coin | cosmetic, or a body claiming real charges is a bad body.
 */
import { describe, expect, it } from "vitest";
import { cosmeticsView, purchaseResult, storeView } from "../test/storeFixtures.ts";
import { ShapeError, expectShape } from "./shape.ts";
import { cosmeticsShape, purchaseResultShape, storeShape } from "./shapes.ts";

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ShapeError) return err.message;
    throw err;
  }
  return "accepted";
};

const clone = (v: unknown): unknown => JSON.parse(JSON.stringify(v)) as unknown;

describe("store guards", () => {
  it("accept the fixtures the component tests use", () => {
    expect(() => expectShape(storeShape, storeView())).not.toThrow();
    expect(() => expectShape(storeShape, storeView({ purchased: [1, 2, 3], balance: 49_000 }))).not.toThrow();
    expect(() => expectShape(purchaseResultShape, purchaseResult(storeView().offers[0]!))).not.toThrow();
    expect(() => expectShape(cosmeticsShape, cosmeticsView(["fence_style.weathered_grey"], { fence_style: "fence_style.weathered_grey" }))).not.toThrow();
  });

  it("refuse an offer whose headline Coin is not what its contents grant", () => {
    const s = clone(storeView()) as { offers: { coin: number }[] };
    s.offers[1]!.coin = 99_999;
    expect(reason(() => expectShape(storeShape, s))).toMatch(/offers\[1\]\.coin/);
  });

  it("refuse an offer that shows a cosmetic it does not grant, or grants one it does not show", () => {
    const shown = clone(storeView()) as { offers: { cosmetics: unknown[] }[] };
    shown.offers[0]!.cosmetics = [];
    expect(reason(() => expectShape(storeShape, shown))).toMatch(/offers\[0\]\.cosmetics/);
    const extra = clone(storeView()) as { offers: { contents: unknown[] }[] };
    extra.offers[2]!.contents.push({ kind: "cosmetic", cosmeticId: "secret.bonus" });
    expect(reason(() => expectShape(storeShape, extra))).toMatch(/offers\[2\]\.cosmetics/);
  });

  it("refuse any content kind but coin | cosmetic, and anything but exactly one coin entry", () => {
    for (const bad of [{ kind: "unlock_points", amount: 1 }, { kind: "reroll", count: 1 }, { kind: "mystery_box" }]) {
      const s = clone(storeView()) as { offers: { contents: unknown[] }[] };
      s.offers[0]!.contents.push(bad);
      expect(reason(() => expectShape(storeShape, s))).toMatch(/offers\[0\]\.contents\[2\]\.kind/);
    }
    const two = clone(storeView()) as { offers: { contents: unknown[] }[] };
    two.offers[0]!.contents.push({ kind: "coin", amount: 1 });
    expect(reason(() => expectShape(storeShape, two))).toMatch(/exactly one coin entry/);
  });

  it("refuse a storefront that claims real charges or is not the sandbox", () => {
    const real = clone(storeView()) as { backend: { realCharges: boolean } };
    real.backend.realCharges = true;
    expect(reason(() => expectShape(storeShape, real))).toMatch(/backend\.realCharges/);
    const purchase = clone(purchaseResult(storeView().offers[0]!)) as { sandbox: boolean };
    purchase.sandbox = false;
    expect(reason(() => expectShape(purchaseResultShape, purchase))).toMatch(/sandbox/);
  });

  it("refuse a cosmetic kind the content package does not know", () => {
    const c = clone(cosmeticsView(["fence_style.weathered_grey"])) as { owned: { kind: string }[] };
    c.owned[0]!.kind = "stat_boost";
    expect(reason(() => expectShape(cosmeticsShape, c))).toMatch(/owned\[0\]\.kind/);
  });
});
