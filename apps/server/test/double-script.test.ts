/**
 * Chunk 24 QA S5: the e2e double's one script (src/dev/testResolver.ts DOUBLE_SCRIPT), so the
 * onboarding e2e can walk the path most real first trips take — an overrun at encounter 1 —
 * with a de-merged survivor and without one. Pure: read off the committed arrangement only.
 */
import { describe, expect, it } from "vitest";
import { DOUBLE_SCRIPT } from "../src/dev/testResolver.js";
import { plannedResolver } from "../src/dev/tripDouble.js";
import type { EncounterResolverInput } from "../src/trip/outcome.js";

const input = (encounterIndex: number, fences: number, traps: number): EncounterResolverInput =>
  ({
    tripId: "t",
    encounterIndex,
    formation: {
      v: 2,
      fences: Array.from({ length: fences }, (_, i) => ({ ref: `f${i}`, segment: i })),
      traps: Array.from({ length: traps }, (_, i) => ({ ref: `t${i}`, cell: { x: 10 + i, y: 10 } })),
      posts: [
        { ref: "b-unit", cell: { x: 12, y: 12 }, stance: "guard" },
        { ref: "a-unit", cell: { x: 13, y: 12 }, stance: "guard" },
      ],
    },
    survivors: {
      units: [
        { ref: "a-unit", typeId: "desert.dust_rider", mergeLevel: 1, hp: 620 },
        { ref: "b-unit", typeId: "desert.dust_rider", mergeLevel: 1, hp: 620 },
      ],
      traps: Array.from({ length: traps }, (_, i) => ({ ref: `t${i}`, typeId: "trap.spike_pit", spent: false })),
      fences: Array.from({ length: fences }, (_, i) => ({ ref: `f${i}`, tierId: "fence.brush_pile", hp: 400 })),
    },
    party: { v: 1, units: [], siege: [] },
    contentHash: null,
  }) as unknown as EncounterResolverInput;

describe("the e2e double's overrun script (chunk 24 QA S5)", () => {
  it("an encounter-1 circle with no fence is overrun; a laid trap means the lowest-ref post dies in the fight (de-merged, kept)", () => {
    expect(DOUBLE_SCRIPT(input(1, 0, 0))).toEqual({ kind: "caravan_overrun", killLowestRefPosts: 0, spendTraps: 0 });
    expect(DOUBLE_SCRIPT(input(1, 0, 1))).toEqual({ kind: "caravan_overrun", killLowestRefPosts: 1, spendTraps: 1 });
    const r = plannedResolver({}, { kind: "caravan_held" }, DOUBLE_SCRIPT).resolve(input(1, 0, 1)).outcome;
    expect(r.kind).toBe("caravan_overrun");
    expect(r.units).toEqual([
      { ref: "b-unit", hp: 620 },
      { ref: "a-unit", hp: 0 },
    ]);
  });

  it("a fenced encounter 1, and every later encounter, follow the ordinary table (the trip e2e is unchanged)", () => {
    expect(DOUBLE_SCRIPT(input(1, 1, 0))).toBeNull();
    expect(DOUBLE_SCRIPT(input(2, 0, 0))).toBeNull();
    expect(plannedResolver({}, { kind: "caravan_held" }, DOUBLE_SCRIPT).resolve(input(2, 0, 0)).outcome.kind).toBe("caravan_held");
  });
});
