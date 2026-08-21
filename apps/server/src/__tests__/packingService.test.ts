import { describe, expect, it } from "vitest";
import { TUNABLES } from "@caravan/content";
import { ACCOUNT_ID, CARAVAN_ID, DEFAULT_NOW, buildEconomyHarness } from "./fixtures.js";
import { PackingValidationError } from "../services/packingService.js";

describe("PackingService", () => {
  describe("pack", () => {
    it("creates a valid manifest within caps", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 0 });
      const manifest = h.packingService.pack(
        {
          caravanId: CARAVAN_ID,
          livingUnitInstanceIds: ["unit_0", "unit_1", "unit_2"],
          trapTypeIds: ["trap.snare_wire"],
          fenceMaterialBudget: 16,
        },
        CARAVAN_ID,
        ACCOUNT_ID,
      );
      expect(manifest.livingUnits.length).toBe(3);
      expect(manifest.traps.length).toBe(1);
      expect(manifest.fenceMaterialBudget).toBe(16);
    });

    it("throws when living units exceed DEPLOYMENT_SLOT_CAP", () => {
      const h = buildEconomyHarness({ unitCount: 20, initialCoin: 0 });
      const tooMany = Array.from({ length: TUNABLES.DEPLOYMENT_SLOT_CAP + 1 }, (_, i) => `unit_${i}`);
      expect(() =>
        h.packingService.pack(
          { caravanId: CARAVAN_ID, livingUnitInstanceIds: tooMany, trapTypeIds: [], fenceMaterialBudget: 0 },
          CARAVAN_ID,
          ACCOUNT_ID,
        ),
      ).toThrow(PackingValidationError);
    });

    it("throws when traps exceed TRAP_SLOT_CAP", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 0 });
      const tooMany = Array.from({ length: TUNABLES.TRAP_SLOT_CAP + 1 }, () => "trap.snare_wire");
      expect(() =>
        h.packingService.pack(
          { caravanId: CARAVAN_ID, livingUnitInstanceIds: ["unit_0"], trapTypeIds: tooMany, fenceMaterialBudget: 0 },
          CARAVAN_ID,
          ACCOUNT_ID,
        ),
      ).toThrow(PackingValidationError);
    });

    it("throws when fence budget exceeds FENCE_MATERIAL_BUDGET", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 0 });
      expect(() =>
        h.packingService.pack(
          {
            caravanId: CARAVAN_ID,
            livingUnitInstanceIds: ["unit_0"],
            trapTypeIds: [],
            fenceMaterialBudget: TUNABLES.FENCE_MATERIAL_BUDGET + 1,
          },
          CARAVAN_ID,
          ACCOUNT_ID,
        ),
      ).toThrow(PackingValidationError);
    });

    it("throws when unit does not belong to caravan", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 0 });
      h.unitRepo.save({ id: "unit_wrong", caravanId: "car_other", typeId: "desert.duster", mergeLevel: 1 });
      expect(() =>
        h.packingService.pack(
          { caravanId: CARAVAN_ID, livingUnitInstanceIds: ["unit_wrong"], trapTypeIds: [], fenceMaterialBudget: 0 },
          CARAVAN_ID,
          ACCOUNT_ID,
        ),
      ).toThrow(PackingValidationError);
    });

    it("throws when trap type is unknown", () => {
      const h = buildEconomyHarness({ unitCount: 8, initialCoin: 0 });
      expect(() =>
        h.packingService.pack(
          { caravanId: CARAVAN_ID, livingUnitInstanceIds: ["unit_0"], trapTypeIds: ["trap.nonexistent"], fenceMaterialBudget: 0 },
          CARAVAN_ID,
          ACCOUNT_ID,
        ),
      ).toThrow(PackingValidationError);
    });
  });

  describe("state transitions", () => {
    it("starts in_town", () => {
      const h = buildEconomyHarness();
      const state = h.packingService.getCaravanState(CARAVAN_ID);
      expect(state).toBe("in_town");
    });

    it("depart transitions to on_trip", () => {
      const h = buildEconomyHarness();
      const manifest = h.packingService.pack(
        { caravanId: CARAVAN_ID, livingUnitInstanceIds: ["unit_0", "unit_1"], trapTypeIds: [], fenceMaterialBudget: 8 },
        CARAVAN_ID,
        ACCOUNT_ID,
      );
      h.packingService.depart(CARAVAN_ID, manifest, DEFAULT_NOW);
      expect(h.packingService.getCaravanState(CARAVAN_ID)).toBe("on_trip");
    });

    it("throws on depart when already on a trip", () => {
      const h = buildEconomyHarness();
      const manifest = h.packingService.pack(
        { caravanId: CARAVAN_ID, livingUnitInstanceIds: ["unit_0", "unit_1"], trapTypeIds: [], fenceMaterialBudget: 8 },
        CARAVAN_ID,
        ACCOUNT_ID,
      );
      h.packingService.depart(CARAVAN_ID, manifest, DEFAULT_NOW);
      expect(() => h.packingService.depart(CARAVAN_ID, manifest, DEFAULT_NOW)).toThrow(PackingValidationError);
    });

    it("throws on depart with empty manifest", () => {
      const h = buildEconomyHarness();
      const manifest = h.packingService.pack(
        { caravanId: CARAVAN_ID, livingUnitInstanceIds: [], trapTypeIds: [], fenceMaterialBudget: 0 },
        CARAVAN_ID,
        ACCOUNT_ID,
      );
      expect(() => h.packingService.depart(CARAVAN_ID, manifest, DEFAULT_NOW)).toThrow(PackingValidationError);
    });

    it("returnToTown resets state and clears manifest", () => {
      const h = buildEconomyHarness();
      const manifest = h.packingService.pack(
        { caravanId: CARAVAN_ID, livingUnitInstanceIds: ["unit_0", "unit_1"], trapTypeIds: [], fenceMaterialBudget: 8 },
        CARAVAN_ID,
        ACCOUNT_ID,
      );
      h.packingService.depart(CARAVAN_ID, manifest, DEFAULT_NOW);
      expect(h.packingService.getManifest(CARAVAN_ID)).not.toBeNull();
      h.packingService.returnToTown(CARAVAN_ID);
      expect(h.packingService.getCaravanState(CARAVAN_ID)).toBe("in_town");
      expect(h.packingService.getManifest(CARAVAN_ID)).toBeNull();
    });
  });
});