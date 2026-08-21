import { describe, expect, it } from "vitest";
import { TUNABLES } from "@caravan/content";
import { ACCOUNT_ID, CARAVAN_ID, DEFAULT_NOW, buildEconomyHarness } from "./fixtures.js";
import { MergeValidationError } from "../services/mergeService.js";

describe("MergeService", () => {
  describe("preview", () => {
    it("returns merge preview for valid 2→1 merge at level 1→2", () => {
      // unit_0 (desert.duster) and unit_4 (desert.duster) are same type
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 10_000 });
      const preview = h.mergeService.preview({
        caravanId: CARAVAN_ID,
        consumedUnitInstanceIds: ["unit_0", "unit_4"],
        recipe: "small",
      });
      expect(preview.targetLevel).toBe(2);
      expect(preview.coinCost).toBeGreaterThan(0);
      expect(preview.consumeCount).toBe(2);
      expect(preview.produceCount).toBe(1);
      // Check that component stats are level 1, result stats are level 2
      expect(preview.componentStats.offense).toBeGreaterThan(0);
      expect(preview.resultStats.offense).toBeGreaterThan(preview.componentStats.offense);
    });

    it("returns merge preview for valid 5→3 merge", () => {
      // Units 0,4 are desert.duster; we need more same-type copies
      // Create 5 desert.duster copies for testing
      const h = buildEconomyHarness({ unitCount: 20, initialCoin: 10_000 });
      // unit_0, unit_4, unit_8, unit_12, unit_16 are all desert.duster
      const preview = h.mergeService.preview({
        caravanId: CARAVAN_ID,
        consumedUnitInstanceIds: ["unit_0", "unit_4", "unit_8", "unit_12", "unit_16"],
        recipe: "large",
      });
      expect(preview.targetLevel).toBe(2);
      expect(preview.consumeCount).toBe(5);
      expect(preview.produceCount).toBe(3);
    });

    it("throws on mismatched unit types", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 10_000 });
      // unit_0 is desert.duster, unit_1 is desert.sharpshooter — different types
      expect(() =>
        h.mergeService.preview({
          caravanId: CARAVAN_ID,
          consumedUnitInstanceIds: ["unit_0", "unit_1"],
          recipe: "small",
        }),
      ).toThrow(MergeValidationError);
    });

    it("throws on wrong count for recipe", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 10_000 });
      expect(() =>
        h.mergeService.preview({
          caravanId: CARAVAN_ID,
          consumedUnitInstanceIds: ["unit_0"],
          recipe: "small",
        }),
      ).toThrow(MergeValidationError);
    });

    it("throws when target level exceeds cap", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 10_000 });
      // Create level-5 units to test cap enforcement
      h.unitRepo.save({ id: "unit_l5a", caravanId: CARAVAN_ID, typeId: "desert.duster", mergeLevel: TUNABLES.MERGE_LEVEL_CAP });
      h.unitRepo.save({ id: "unit_l5b", caravanId: CARAVAN_ID, typeId: "desert.duster", mergeLevel: TUNABLES.MERGE_LEVEL_CAP });
      expect(() =>
        h.mergeService.preview({
          caravanId: CARAVAN_ID,
          consumedUnitInstanceIds: ["unit_l5a", "unit_l5b"],
          recipe: "small",
        }),
      ).toThrow(MergeValidationError);
    });

    it("throws when unit belongs to different caravan", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 10_000 });
      h.unitRepo.save({ id: "unit_other", caravanId: "car_other", typeId: "desert.duster", mergeLevel: 1 });
      expect(() =>
        h.mergeService.preview({
          caravanId: CARAVAN_ID,
          consumedUnitInstanceIds: ["unit_0", "unit_other"],
          recipe: "small",
        }),
      ).toThrow(MergeValidationError);
    });
  });

  describe("execute", () => {
    it("consumes 2 units and produces 1 merged unit at level 2", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 10_000 });
      const output = h.mergeService.execute(
        {
          caravanId: CARAVAN_ID,
          consumedUnitInstanceIds: ["unit_0", "unit_4"], // both desert.duster
          recipe: "small",
        },
        ACCOUNT_ID,
        DEFAULT_NOW,
      );
      // Consumed units: unit_0 is replaced by produced unit (same id from generator),
      // unit_4 is deleted and not reused — check it's gone
      expect(h.unitRepo.get("unit_0")!.mergeLevel).toBe(2); // now the produced unit
      expect(h.unitRepo.get("unit_4")).toBeUndefined();
      // Produced unit should exist at level 2
      expect(output.producedUnitInstances.length).toBe(1);
      expect(output.producedUnitInstances[0]!.mergeLevel).toBe(2);
      expect(output.targetLevel).toBe(2);
      expect(output.coinCost).toBeGreaterThan(0);
      // Coin should be deducted
      expect(h.coinService.getBalance(ACCOUNT_ID)).toBeLessThan(10_000);
    });

    it("produces 3 units from 5 for large recipe", () => {
      const h = buildEconomyHarness({ unitCount: 20, initialCoin: 10_000 });
      // unit_0, unit_4, unit_8, unit_12, unit_16 are all desert.duster
      const output = h.mergeService.execute(
        {
          caravanId: CARAVAN_ID,
          consumedUnitInstanceIds: ["unit_0", "unit_4", "unit_8", "unit_12", "unit_16"],
          recipe: "large",
        },
        ACCOUNT_ID,
        DEFAULT_NOW,
      );
      expect(output.producedUnitInstances.length).toBe(3);
      expect(output.producedUnitInstances[0]!.mergeLevel).toBe(2);
    });

    it("writes a coin_spent ledger event", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 10_000 });
      h.mergeService.execute(
        { caravanId: CARAVAN_ID, consumedUnitInstanceIds: ["unit_0", "unit_4"], recipe: "small" },
        ACCOUNT_ID,
        DEFAULT_NOW,
      );
      const events = h.ledgerRepo.listByAccount(ACCOUNT_ID);
      const spendEvents = events.filter((e) => e.kind === "coin_spent");
      expect(spendEvents.length).toBe(1);
    });

    it("throws on insufficient coins", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 0 });
      expect(() =>
        h.mergeService.execute(
          { caravanId: CARAVAN_ID, consumedUnitInstanceIds: ["unit_0", "unit_4"], recipe: "small" },
          ACCOUNT_ID,
          DEFAULT_NOW,
        ),
      ).toThrow(MergeValidationError);
    });

    it("throws on unknown unit instance id", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 10_000 });
      expect(() =>
        h.mergeService.execute(
          { caravanId: CARAVAN_ID, consumedUnitInstanceIds: ["unit_0", "nonexistent"], recipe: "small" },
          ACCOUNT_ID,
          DEFAULT_NOW,
        ),
      ).toThrow(MergeValidationError);
    });
  });
});