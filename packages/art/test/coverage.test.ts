import { describe, expect, it } from "vitest";
import { checkCoverage, expectedIds } from "../src/coverage.ts";

const errors = <T extends { level: string }>(f: T[]): T[] => f.filter((x) => x.level === "error");

describe("expectedIds", () => {
  const e = expectedIds();
  it("lists unit ids from the content package and fixes the wagon set", () => {
    expect(e.units).toContain("desert.sand_sharpshooter");
    expect(e.units).toContain("desert.well_digger");
    expect(e.units).toContain("desert.coyote_pack");
    expect([...(e.wagons ?? [])].sort()).toEqual(["core", "covered_front", "covered_rear", "supply_front", "supply_rear"]);
  });
  it("leaves town and ui free-form", () => {
    expect(e.town).toBeNull();
    expect(e.ui).toBeNull();
  });
  it("lists traps, siege, fences, terrain and cosmetics", () => {
    for (const c of ["traps", "siege", "fences", "terrain", "cosmetics"] as const) {
      expect(Array.isArray(e[c]), c).toBe(true);
    }
  });
});

describe("checkCoverage", () => {
  it("passes when every expected id has an asset", () => {
    expect(checkCoverage({ expected: { traps: ["a", "b"] }, assets: { traps: ["a", "b"] }, fallbacks: {} })).toEqual([]);
  });
  it("errors on an expected id with neither asset nor fallback", () => {
    const f = checkCoverage({ expected: { traps: ["a", "b"] }, assets: { traps: ["a"] }, fallbacks: {} });
    expect(errors(f).map((x) => x.id)).toEqual(["traps/b"]);
  });
  it("counts a fallback as coverage", () => {
    const f = checkCoverage({ expected: { traps: ["a", "b"] }, assets: { traps: ["a"] }, fallbacks: { traps: ["b"] } });
    expect(f).toEqual([]);
  });
  it("warns, not errors, when an id has both asset and fallback", () => {
    const f = checkCoverage({ expected: { traps: ["a"] }, assets: { traps: ["a"] }, fallbacks: { traps: ["a"] } });
    expect(errors(f)).toEqual([]);
    expect(f.filter((x) => x.level === "warning").map((x) => x.id)).toEqual(["traps/a"]);
  });
  it("errors on an unknown asset key and an unknown fallback key", () => {
    const f = checkCoverage({ expected: { traps: ["a"] }, assets: { traps: ["a", "zzz"] }, fallbacks: { traps: ["yyy"] } });
    expect(errors(f).map((x) => x.id).sort()).toEqual(["traps/yyy", "traps/zzz"]);
  });
  it("errors on a class present in assets but absent from expected", () => {
    const f = checkCoverage({ expected: {}, assets: { siege: ["x"] }, fallbacks: {} });
    expect(errors(f).length).toBeGreaterThan(0);
  });
  it("accepts any key in a free-form (null) class and needs nothing", () => {
    expect(checkCoverage({ expected: { town: null }, assets: { town: ["saloon", "anything"] }, fallbacks: {} })).toEqual([]);
    expect(checkCoverage({ expected: { ui: null }, assets: {}, fallbacks: {} })).toEqual([]);
  });
});
