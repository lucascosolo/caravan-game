import { describe, expect, it } from "vitest";
import { applyEncounterOutcome, manifestSummary, validateFormation, type EncounterOutcome } from "../src/index.js";
import { ALLOW_ALL, arrange, fullPack } from "./fixtures.js";

const NOTHING: EncounterOutcome = { units: [], spentTraps: [], fences: [] };

describe("carry-forward attrition", () => {
  it("a trap spent at encounter 2 is still spent at encounter 3 — it does not re-arm", () => {
    const m1 = fullPack();
    const m2 = applyEncounterOutcome(m1, NOTHING); // encounter 1: nothing fired
    expect(m2.traps.every((t) => !t.spent)).toBe(true);
    const m3 = applyEncounterOutcome(m2, { ...NOTHING, spentTraps: ["t2"] }); // encounter 2: t2 fired
    expect(m3.traps.find((t) => t.ref === "t2")!.spent).toBe(true);
    const m4 = applyEncounterOutcome(m3, NOTHING); // encounter 3: t2 did not fire (it couldn't)
    expect(m4.traps.find((t) => t.ref === "t2")!.spent).toBe(true);
    const m5 = applyEncounterOutcome(m4, { ...NOTHING, spentTraps: ["t2"] }); // reported spent again: idempotent, still spent
    expect(m5.traps.find((t) => t.ref === "t2")!.spent).toBe(true);
    // And it cannot be laid again at encounter 4.
    const f = arrange(m1); // the encounter-1 arrangement, which laid t2
    const res = validateFormation(m5, f, ALLOW_ALL);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => i.code)).toEqual(["trap_spent"]);
    // Arranging from what survives works.
    expect(validateFormation(m5, arrange(m5), ALLOW_ALL).ok).toBe(true);
    expect(arrange(m5).traps.map((t) => t.ref)).toEqual(["t0", "t1", "t3", "t4", "t5"]);
    // The original manifest is untouched: each step is a new frozen value.
    expect(m1.traps.find((t) => t.ref === "t2")!.spent).toBe(false);
  });

  it("unit damage and death persist: a dead unit cannot be posted, a hurt one stays hurt", () => {
    const m1 = fullPack();
    const m2 = applyEncounterOutcome(m1, { ...NOTHING, units: [{ ref: "u-rider", hp: 100 }, { ref: "u-bull", hp: 0 }] });
    expect(m2.units.find((u) => u.ref === "u-rider")!.hp).toBe(100);
    expect(m2.units.find((u) => u.ref === "u-bull")!.hp).toBe(0);
    const m3 = applyEncounterOutcome(m2, NOTHING);
    expect(m3.units.find((u) => u.ref === "u-rider")!.hp).toBe(100);
    expect(m3.units.find((u) => u.ref === "u-bull")!.hp).toBe(0);
    const res = validateFormation(m3, arrange(m1), ALLOW_ALL);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => i.code)).toEqual(["unit_dead"]);
    expect(validateFormation(m3, arrange(m3), ALLOW_ALL).ok).toBe(true);
    expect(arrange(m3).posts).toHaveLength(7);
    expect(manifestSummary(m3)).toEqual({ unitsAlive: 7, unitsDead: 1, trapsUnspent: 6, trapsSpent: 0, fencesIntact: 24, fencesDestroyed: 0 });
  });

  it("destroyed fence segments are gone; damaged ones keep their reduced HP", () => {
    const m1 = fullPack();
    const m2 = applyEncounterOutcome(m1, { ...NOTHING, fences: [{ ref: "f0", hp: 0 }, { ref: "f1", hp: 37 }] });
    expect(m2.fences.find((f) => f.ref === "f0")!.hp).toBe(0);
    expect(m2.fences.find((f) => f.ref === "f1")!.hp).toBe(37);
    const m3 = applyEncounterOutcome(m2, NOTHING);
    expect(m3.fences.find((f) => f.ref === "f1")!.hp).toBe(37);
    const res = validateFormation(m3, arrange(m1), ALLOW_ALL);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => i.code)).toEqual(["fence_destroyed"]);
    expect(arrange(m3).fences).toHaveLength(23);
    expect(validateFormation(m3, arrange(m3), ALLOW_ALL).ok).toBe(true);
  });

  it("is monotone: an outcome that would heal, repair or re-arm is a bug and is refused", () => {
    const m1 = fullPack();
    const m2 = applyEncounterOutcome(m1, { ...NOTHING, units: [{ ref: "u-rider", hp: 100 }], fences: [{ ref: "f0", hp: 10 }] });
    expect(() => applyEncounterOutcome(m2, { ...NOTHING, units: [{ ref: "u-rider", hp: 101 }] })).toThrow(/no healing/);
    expect(() => applyEncounterOutcome(m2, { ...NOTHING, fences: [{ ref: "f0", hp: 11 }] })).toThrow(/no repair/);
    expect(() => applyEncounterOutcome(m2, { ...NOTHING, units: [{ ref: "u-rider", hp: -1 }] })).toThrow();
    expect(() => applyEncounterOutcome(m2, { ...NOTHING, units: [{ ref: "u-rider", hp: 1.5 }] })).toThrow();
    expect(() => applyEncounterOutcome(m2, { ...NOTHING, units: [{ ref: "u-ghost", hp: 1 }] })).toThrow(/not in the manifest/);
    expect(() => applyEncounterOutcome(m2, { ...NOTHING, spentTraps: ["t42"] })).toThrow(/not in the manifest/);
    expect(() => applyEncounterOutcome(m2, { ...NOTHING, fences: [{ ref: "f0", hp: 5 }, { ref: "f0", hp: 5 }] })).toThrow(/twice/);
    // There is no outcome shape that mentions a trap becoming unspent at all.
    expect(Object.keys(NOTHING).sort()).toEqual(["fences", "spentTraps", "units"]);
  });
});
