import { describe, expect, it } from "vitest";
import { LIVING_UNIT_TYPES } from "./roster.js";
import { TUNABLES } from "./tunables.js";
import { mergeCostForTargetLevel, mergeRecipeSpec, statBlockLessThan, statsAtLevel, sumStats, type StatBlock } from "./merge.js";

function baseOf(typeId: string): StatBlock {
  const type = LIVING_UNIT_TYPES.find((t) => t.id === typeId)!;
  return { offense: type.offense, defense: type.defense, hp: type.hp };
}

describe("MERGE_STAT_MULT_PER_LEVEL — the no-pay-to-win guardrail's own number", () => {
  it("is strictly below ×2.0 (2000 milli), the 2-for-1 recipe's implied rate", () => {
    expect(TUNABLES.MERGE_STAT_MULT_PER_LEVEL_MILLI).toBeLessThan(2000);
  });
});

describe("statsAtLevel — canonical, path-independent level->stat mapping", () => {
  it("level 1 is exactly the authored base stats, unscaled", () => {
    const base = baseOf("desert.duster");
    expect(statsAtLevel(base, 1)).toEqual(base);
  });

  it("every level above 1 truncates an integer ×1.8 scale-up, with no float drift", () => {
    const base = baseOf("desert.sharpshooter");
    let expected = base;
    for (let level = 2; level <= TUNABLES.MERGE_LEVEL_CAP; level++) {
      expected = {
        offense: Math.trunc((expected.offense * 1800) / 1000),
        defense: Math.trunc((expected.defense * 1800) / 1000),
        hp: Math.trunc((expected.hp * 1800) / 1000),
      };
      expect(statsAtLevel(base, level)).toEqual(expected);
      // Every field must be an integer — no floats anywhere (GUARDRAILS.md #1).
      const actual = statsAtLevel(base, level);
      expect(Number.isInteger(actual.offense)).toBe(true);
      expect(Number.isInteger(actual.defense)).toBe(true);
      expect(Number.isInteger(actual.hp)).toBe(true);
    }
  });

  it("rejects levels outside [1, MERGE_LEVEL_CAP]", () => {
    const base = baseOf("desert.duster");
    expect(() => statsAtLevel(base, 0)).toThrow(RangeError);
    expect(() => statsAtLevel(base, TUNABLES.MERGE_LEVEL_CAP + 1)).toThrow(RangeError);
    expect(() => statsAtLevel(base, 1.5)).toThrow(RangeError);
  });
});

describe("CRITICAL: a merged unit is never stronger than the components consumed to make it", () => {
  const recipes = ["small", "large"] as const;

  for (const typeId of LIVING_UNIT_TYPES.map((t) => t.id)) {
    for (const recipe of recipes) {
      const spec = mergeRecipeSpec(recipe);

      for (let fromLevel = 1; fromLevel < TUNABLES.MERGE_LEVEL_CAP; fromLevel++) {
        const targetLevel = fromLevel + 1;

        it(`${typeId}: recipe ${recipe} L${fromLevel}->L${targetLevel} — merged unit strictly weaker than its ${spec.consumeCount} consumed components combined`, () => {
          const base = baseOf(typeId);
          const componentStats = statsAtLevel(base, fromLevel);
          const consumedStatsSum = sumStats(Array.from({ length: spec.consumeCount }, () => componentStats));
          const resultingStats = statsAtLevel(base, targetLevel);

          expect(statBlockLessThan(resultingStats, consumedStatsSum)).toBe(true);
          // Every one of the recipe's outputs is identical (canonical,
          // level-defined stats) and each individually is still weaker than
          // the whole consumed batch.
          for (let i = 0; i < spec.produceCount; i++) {
            expect(statBlockLessThan(resultingStats, consumedStatsSum)).toBe(true);
          }
        });
      }
    }
  }

  it("2-for-1 specifically: one output is less than exactly its two inputs summed (the tightest case)", () => {
    const base = baseOf("desert.duster");
    for (let fromLevel = 1; fromLevel < TUNABLES.MERGE_LEVEL_CAP; fromLevel++) {
      const componentStats = statsAtLevel(base, fromLevel);
      const twoInputs = sumStats([componentStats, componentStats]);
      const output = statsAtLevel(base, fromLevel + 1);
      expect(statBlockLessThan(output, twoInputs)).toBe(true);
    }
  });
});

describe("merge cost lookup", () => {
  it("has an entry for every level above 1, escalating steeply", () => {
    let previous = 0;
    for (let level = 2; level <= TUNABLES.MERGE_LEVEL_CAP; level++) {
      const cost = mergeCostForTargetLevel(level);
      expect(cost).toBeGreaterThan(previous);
      previous = cost;
    }
  });

  it("throws for level 1 (nothing merges into level 1) and beyond the cap", () => {
    expect(() => mergeCostForTargetLevel(1)).toThrow(RangeError);
    expect(() => mergeCostForTargetLevel(TUNABLES.MERGE_LEVEL_CAP + 1)).toThrow(RangeError);
  });
});
