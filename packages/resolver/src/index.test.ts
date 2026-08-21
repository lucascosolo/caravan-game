import { describe, expect, it } from "vitest";
import { resolveEncounter, type EncounterInput } from "./index.js";

function fixture(totalDefense: number): EncounterInput {
  return {
    attackingParty: {
      partyId: "party_1",
      snapshotVersion: 3,
      units: [
        {
          slotIndex: 0,
          unitInstanceId: "unit_a",
          typeId: "desert.duster",
          mergeLevel: 2,
          offense: 90,
          defense: 40,
          hp: 600,
          stance: "nearest",
          edge: "north",
          startPosition: { x: 4, y: 0 },
        },
        {
          slotIndex: 1,
          unitInstanceId: "unit_b",
          typeId: "desert.sharpshooter",
          mergeLevel: 1,
          offense: 110,
          defense: 25,
          hp: 400,
          stance: "core",
          edge: "north",
          startPosition: { x: 5, y: 0 },
        },
      ],
      siege: [
        {
          slotIndex: 0,
          typeId: "siege.dynamite",
          countersFenceCategory: "stone",
          countersTrapCategory: null,
          edge: "north",
          startPosition: { x: 6, y: 0 },
        },
      ],
    },
    defendingSide: { tripId: "trip_1", totalDefense, coreDistance: 32 },
  };
}

describe("resolveEncounter — determinism harness", () => {
  it("produces a byte-identical tick log across 100 runs of the same input", () => {
    const input = fixture(150);
    const runs = Array.from({ length: 100 }, () => JSON.stringify(resolveEncounter(input)));
    expect(new Set(runs).size).toBe(1);
  });

  it("is a pure function of its input — no shared mutable state between calls", () => {
    const inputA = fixture(150);
    const inputB = fixture(150);
    const resultA = resolveEncounter(inputA);
    const resultB = resolveEncounter(inputB);
    expect(resultA).toEqual(resultB);
    // Calling it again after other calls does not change earlier behavior.
    expect(resolveEncounter(inputA)).toEqual(resultA);
  });

  it("produces all three distinguishable end conditions from aggregate offense vs. defense", () => {
    // offense = 90 + 110 + 40 (one siege slot) = 240
    expect(resolveEncounter(fixture(100)).outcome).toBe("overrun");
    expect(resolveEncounter(fixture(240)).outcome).toBe("stalemate"); // exact tie favors defender
    expect(resolveEncounter(fixture(1000)).outcome).toBe("wipe");
  });

  it("an exact tie (offense === defense) favors the defender, not the attacker", () => {
    const result = resolveEncounter(fixture(240));
    expect(result.outcome).not.toBe("overrun");
  });

  it("never emits a float in the tick log or the outcome", () => {
    const result = resolveEncounter(fixture(333));
    expect(Number.isInteger(result.depthFractionMilli)).toBe(true);
    for (const event of result.tickLog) {
      expect(Number.isInteger(event.tick)).toBe(true);
      if (event.kind === "unit_attack") expect(Number.isInteger(event.damage)).toBe(true);
    }
  });
});
