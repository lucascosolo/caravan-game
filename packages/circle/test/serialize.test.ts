import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import {
  applyEncounterOutcome,
  canonicalJson,
  parseFormation,
  parseManifest,
  serializeFormation,
  serializeManifest,
  type Formation,
} from "../src/index.js";
import { arrange, fullPack } from "./fixtures.js";

describe("formation snapshots", () => {
  const m = fullPack();
  const f = arrange(m, 3);

  it("are byte-identical however the formation was built: list order and key order do not matter", () => {
    const a = serializeFormation(f);
    const shuffled: Formation = {
      posts: [...f.posts].reverse().map((p) => ({ cell: { y: p.cell.y, x: p.cell.x }, ref: p.ref })),
      traps: [...f.traps].sort(() => -1).map((t) => ({ cell: { y: t.cell.y, x: t.cell.x }, ref: t.ref })),
      fences: [...f.fences].reverse().map((p) => ({ segment: p.segment, ref: p.ref })),
      v: 1,
    };
    expect(serializeFormation(shuffled)).toBe(a);
    expect(serializeFormation(f)).toBe(a);
    // 100 re-serializations of the same value: identical bytes.
    for (let i = 0; i < 100; i++) expect(serializeFormation(shuffled)).toBe(a);
  });

  it("are compact, versioned, with sorted keys and no whitespace", () => {
    const s = serializeFormation(f);
    expect(s.startsWith('{"fences":[{"ref":"f0","segment":3}')).toBe(true);
    expect(s.endsWith(',"v":1}')).toBe(true);
    expect(/\s/.test(s)).toBe(false);
    expect(s.length).toBeLessThan(1500);
  });

  it("round-trip: parse(serialize(f)) equals normalize(f)", () => {
    const parsed = parseFormation(serializeFormation(f));
    expect(serializeFormation(parsed)).toBe(serializeFormation(f));
    expect(parsed.fences).toHaveLength(TUNABLES.FENCE_MATERIAL_BUDGET);
    expect(parsed.posts.map((p) => p.ref)).toEqual([...f.posts.map((p) => p.ref)].sort());
  });

  it("parsing is strict: unknown keys, floats, bad versions and off-lattice cells are refused", () => {
    const good = JSON.parse(serializeFormation(f)) as Record<string, unknown>;
    const withKey = (patch: (o: Record<string, unknown>) => void): string => {
      const o = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      patch(o);
      return JSON.stringify(o);
    };
    expect(() => parseFormation(withKey((o) => (o["elevation"] = [1, 2, 3])))).toThrow(/unknown key 'elevation'/);
    expect(() => parseFormation(withKey((o) => (o["terrain"] = "mud")))).toThrow(/unknown key 'terrain'/);
    expect(() => parseFormation(withKey((o) => ((o["posts"] as Record<string, unknown>[])[0]!["cover"] = 2)))).toThrow(/unknown key 'cover'/);
    expect(() => parseFormation(withKey((o) => (((o["posts"] as Record<string, unknown>[])[0]!["cell"] as Record<string, unknown>)["z"] = 1)))).toThrow(/unknown key 'z'/);
    expect(() => parseFormation(withKey((o) => (((o["posts"] as Record<string, unknown>[])[0]!["cell"] as Record<string, unknown>)["x"] = 12.5)))).toThrow(/safe integer/);
    expect(() => parseFormation(withKey((o) => ((o["fences"] as Record<string, unknown>[])[0]!["segment"] = 0.5)))).toThrow(/safe integer/);
    expect(() => parseFormation(withKey((o) => ((o["fences"] as Record<string, unknown>[])[0]!["segment"] = 99)))).toThrow(/ring position/);
    expect(() => parseFormation(withKey((o) => (((o["traps"] as Record<string, unknown>[])[0]!["cell"] as Record<string, unknown>)["x"] = 40)))).toThrow(/off the lattice/);
    expect(() => parseFormation(withKey((o) => (o["v"] = 2)))).toThrow(/version/);
    expect(() => parseFormation(withKey((o) => delete o["traps"]))).toThrow(/missing 'traps'/);
    expect(() => parseFormation("not json")).toThrow(/not JSON/);
    expect(() => parseFormation("[]")).toThrow(/must be an object/);
  });
});

describe("manifest snapshots", () => {
  it("round-trip through canonical JSON, including carried-forward attrition", () => {
    const m1 = fullPack();
    const m2 = applyEncounterOutcome(m1, { units: [{ ref: "u-bull", hp: 0 }, { ref: "u-rider", hp: 5 }], spentTraps: ["t1"], fences: [{ ref: "f3", hp: 0 }] });
    const s = serializeManifest(m2);
    const back = parseManifest(s);
    expect(serializeManifest(back)).toBe(s);
    expect(back.units.find((u) => u.ref === "u-bull")!.hp).toBe(0);
    expect(back.traps.find((t) => t.ref === "t1")!.spent).toBe(true);
    expect(back.fences.find((f) => f.ref === "f3")!.hp).toBe(0);
    expect(Object.isFrozen(back)).toBe(true);
  });

  it("refuses a stored manifest with hp above max, unknown types, duplicate refs or extra keys", () => {
    const good = JSON.parse(serializeManifest(fullPack())) as Record<string, unknown>;
    const mut = (patch: (o: Record<string, unknown>) => void): string => {
      const o = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      patch(o);
      return JSON.stringify(o);
    };
    expect(() => parseManifest(mut((o) => ((o["units"] as Record<string, unknown>[])[0]!["hp"] = 1_000_000)))).toThrow(/hp/);
    expect(() => parseManifest(mut((o) => ((o["units"] as Record<string, unknown>[])[0]!["typeId"] = "desert.unicorn")))).toThrow(/unknown unit type/);
    expect(() => parseManifest(mut((o) => ((o["traps"] as Record<string, unknown>[])[1]!["ref"] = "t0")))).toThrow(/duplicate ref/);
    expect(() => parseManifest(mut((o) => (o["coin"] = 500)))).toThrow(/unknown key 'coin'/);
    expect(() => parseManifest(mut((o) => ((o["units"] as Record<string, unknown>[])[0]!["hp"] = 10.5)))).toThrow(/safe integer/);
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and refuses non-integers", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(() => canonicalJson({ a: 1.5 })).toThrow(/safe integers/);
    expect(() => canonicalJson({ a: Number.MAX_SAFE_INTEGER + 2 })).toThrow(/safe integers/);
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});
