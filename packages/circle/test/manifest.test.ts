import { TUNABLES, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
import { describe, expect, it } from "vitest";
import * as circle from "../src/index.js";
import { packManifest, type PackInput } from "../src/index.js";
import { ALLOW_ALL, fullPack } from "./fixtures.js";

const baseInput: PackInput = {
  units: [{ instanceId: "u1", typeId: "desert.dust_rider", mergeLevel: 1 }],
  traps: ["trap.spike_pit"],
  fence: { tierId: "fence.brush_pile", count: 4 },
};

function issueCodes(input: PackInput, access = ALLOW_ALL): string[] {
  const res = packManifest(input, access);
  return res.ok ? [] : res.issues.map((i) => i.code);
}

describe("packing a manifest", () => {
  it("derives each entry's starting state from content: full hp at the merge level, unspent, intact", () => {
    const m = fullPack();
    expect(m.v).toBe(1);
    expect(m.units).toHaveLength(8);
    const digger = m.units.find((u) => u.ref === "u-digger")!;
    expect(digger.maxHp).toBe(scaleInt(getUnitType("desert.well_digger")!.hp, mergeStatMult(2)));
    expect(digger.hp).toBe(digger.maxHp);
    expect(m.traps.map((t) => t.ref)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5"]);
    expect(m.traps.every((t) => !t.spent)).toBe(true);
    expect(m.fences).toHaveLength(24);
    expect(m.fences.every((f) => f.hp === 300 && f.maxHp === 300 && f.tierId === "fence.brush_pile")).toBe(true);
  });

  it("enforces the deployment slot cap — the bound on what a trip can lose", () => {
    const units = Array.from({ length: TUNABLES.DEPLOYMENT_SLOT_CAP + 1 }, (_, i) => ({ instanceId: `u${i}`, typeId: "desert.dust_rider", mergeLevel: 1 }));
    expect(issueCodes({ ...baseInput, units })).toContain("slot_cap_units");
    expect(packManifest({ ...baseInput, units: units.slice(0, TUNABLES.DEPLOYMENT_SLOT_CAP) }, ALLOW_ALL).ok).toBe(true);
  });

  it("enforces the trap slot cap and the fence material budget", () => {
    const traps = Array.from({ length: TUNABLES.TRAP_SLOT_CAP + 1 }, () => "trap.spike_pit");
    expect(issueCodes({ ...baseInput, traps })).toContain("slot_cap_traps");
    expect(issueCodes({ ...baseInput, fence: { tierId: "fence.brush_pile", count: TUNABLES.FENCE_MATERIAL_BUDGET + 1 } })).toContain("fence_budget");
    expect(issueCodes({ ...baseInput, fence: { tierId: "fence.brush_pile", count: -1 } })).toContain("bad_count");
    expect(issueCodes({ ...baseInput, fence: { tierId: "fence.brush_pile", count: 2.5 } })).toContain("bad_count");
    expect(packManifest({ ...baseInput, fence: null }, ALLOW_ALL).ok).toBe(true);
  });

  it("rejects anything the access seam says is locked — units, traps and fence tiers alike", () => {
    const onlyStarters = (id: string) => id === "desert.dust_rider" || id === "trap.spike_pit" || id === "fence.brush_pile";
    expect(packManifest(baseInput, onlyStarters).ok).toBe(true);
    expect(issueCodes({ ...baseInput, units: [{ instanceId: "u1", typeId: "desert.vaquero", mergeLevel: 1 }] }, onlyStarters)).toEqual(["type_locked"]);
    expect(issueCodes({ ...baseInput, traps: ["trap.powder_keg"] }, onlyStarters)).toEqual(["type_locked"]);
    expect(issueCodes({ ...baseInput, fence: { tierId: "fence.stacked_stone", count: 1 } }, onlyStarters)).toEqual(["type_locked"]);
    expect(issueCodes(baseInput, () => false).sort()).toEqual(["type_locked", "type_locked", "type_locked"]);
  });

  it("rejects unknown types, duplicate instances and out-of-range merge levels", () => {
    expect(issueCodes({ ...baseInput, units: [{ instanceId: "u1", typeId: "desert.unicorn", mergeLevel: 1 }] })).toEqual(["unknown_type"]);
    expect(issueCodes({ ...baseInput, traps: ["trap.landmine"] })).toEqual(["unknown_type"]);
    expect(issueCodes({ ...baseInput, fence: { tierId: "fence.laser", count: 1 } })).toEqual(["unknown_type"]);
    expect(issueCodes({ ...baseInput, units: [baseInput.units[0]!, baseInput.units[0]!] })).toEqual(["duplicate_unit"]);
    expect(issueCodes({ ...baseInput, units: [{ instanceId: "u1", typeId: "desert.dust_rider", mergeLevel: 6 }] })).toEqual(["bad_merge_level"]);
    expect(issueCodes({ ...baseInput, units: [{ instanceId: "u1", typeId: "desert.dust_rider", mergeLevel: 0 }] })).toEqual(["bad_merge_level"]);
  });

  it("reports every problem at once rather than the first", () => {
    const codes = issueCodes({
      units: [{ instanceId: "u1", typeId: "desert.unicorn", mergeLevel: 1 }],
      traps: ["trap.landmine"],
      fence: { tierId: "fence.brush_pile", count: 99 },
    });
    expect(codes.sort()).toEqual(["fence_budget", "unknown_type", "unknown_type"]);
  });
});

describe("the manifest is locked", () => {
  it("is deep-frozen: nothing can be added or changed in place", () => {
    const m = fullPack();
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.units)).toBe(true);
    expect(Object.isFrozen(m.units[0])).toBe(true);
    expect(() => {
      (m.units as unknown as unknown[]).push({ ref: "smuggled", typeId: "desert.vaquero", mergeLevel: 1, maxHp: 1, hp: 1 });
    }).toThrow();
    expect(() => {
      (m.traps[0] as { spent: boolean }).spent = false;
    }).toThrow();
    expect(() => {
      (m.units[0] as { hp: number }).hp = 99_999;
    }).toThrow();
    expect(m.units).toHaveLength(8);
  });

  it("the package exports no function that adds to, resupplies or heals a manifest", () => {
    const names = Object.keys(circle);
    const suspicious = names.filter((n) => /add|resupply|restock|repair|heal|refill|rearm|append|insert/i.test(n));
    expect(suspicious).toEqual([]);
    // The only state-moving function is applyEncounterOutcome, which is monotone (attrition.test.ts).
    expect(names.filter((n) => /manifest/i.test(n) && typeof (circle as Record<string, unknown>)[n] === "function").sort()).toEqual(
      ["assertManifest", "freezeManifest", "manifestFence", "manifestFromJson", "manifestSummary", "manifestTrap", "manifestUnit", "packManifest", "parseManifest", "serializeManifest"],
    );
  });
});
