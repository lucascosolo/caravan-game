import { describe, expect, it } from "vitest";
import { CLASS_RULES, checkAssetRules, type AssetMeta } from "../src/rules.ts";

const meta = (o: Partial<AssetMeta> = {}): AssetMeta => ({ footprint: [20, 27], anchor: [9.33, 26.33], poses: { idle: ["master.png"] }, ...o });
const master = { width: 60, height: 81, bytes: 7000 };

describe("checkAssetRules", () => {
  it("accepts a valid unit", () => {
    expect(checkAssetRules("units", "desert.well_digger", meta(), master)).toEqual([]);
  });
  it("rejects a non-integer or non-positive footprint", () => {
    expect(checkAssetRules("units", "u", meta({ footprint: [20.5, 27] }), { ...master, width: 61.5 }).length).toBeGreaterThan(0);
    expect(checkAssetRules("units", "u", meta({ footprint: [0, 27] }), { ...master, width: 0 }).length).toBeGreaterThan(0);
  });
  it("rejects a footprint beyond the class maximum", () => {
    const [mw, mh] = CLASS_RULES.units.maxFootprint;
    const f = checkAssetRules("units", "u", meta({ footprint: [mw + 1, mh], anchor: [1, mh - 1] }), { width: (mw + 1) * 3, height: mh * 3, bytes: 1000 });
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.level === "error")).toBe(true);
  });
  it("sets generous maxima for units and wagons, ground-anchored", () => {
    expect(CLASS_RULES.units.maxFootprint[0]).toBeGreaterThanOrEqual(40);
    expect(CLASS_RULES.units.maxFootprint[1]).toBeGreaterThanOrEqual(48);
    expect(CLASS_RULES.wagons.maxFootprint[0]).toBeGreaterThanOrEqual(96);
    expect(CLASS_RULES.wagons.maxFootprint[1]).toBeGreaterThanOrEqual(72);
    expect(CLASS_RULES.units.groundAnchor && CLASS_RULES.wagons.groundAnchor).toBe(true);
  });
  it("requires the master at exactly 3x the footprint", () => {
    expect(checkAssetRules("units", "u", meta(), { ...master, width: 59 }).length).toBeGreaterThan(0);
    expect(checkAssetRules("units", "u", meta(), { ...master, height: 82 }).length).toBeGreaterThan(0);
  });
  it("caps the master at 400 KiB", () => {
    expect(checkAssetRules("units", "u", meta(), { ...master, bytes: 400 * 1024 })).toEqual([]);
    expect(checkAssetRules("units", "u", meta(), { ...master, bytes: 400 * 1024 + 1 }).length).toBeGreaterThan(0);
  });
  it("rejects an anchor outside the footprint", () => {
    expect(checkAssetRules("units", "u", meta({ anchor: [21, 26] }), master).length).toBeGreaterThan(0);
    expect(checkAssetRules("units", "u", meta({ anchor: [5, 28] }), master).length).toBeGreaterThan(0);
    expect(checkAssetRules("units", "u", meta({ anchor: [-1, 26] }), master).length).toBeGreaterThan(0);
  });
  it("requires ground-anchored classes to anchor in the lower 40%", () => {
    expect(checkAssetRules("units", "u", meta({ anchor: [10, 0.6 * 27 - 0.5] }), master).length).toBeGreaterThan(0);
    expect(checkAssetRules("units", "u", meta({ anchor: [10, 0.6 * 27] }), master)).toEqual([]);
  });
  it("requires a non-empty idle pose", () => {
    expect(checkAssetRules("units", "u", meta({ poses: {} }), master).length).toBeGreaterThan(0);
    expect(checkAssetRules("units", "u", meta({ poses: { idle: [] } }), master).length).toBeGreaterThan(0);
    expect(checkAssetRules("units", "u", meta({ poses: { walk: ["a.png"] } }), master).length).toBeGreaterThan(0);
  });
});
