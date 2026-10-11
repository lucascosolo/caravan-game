/**
 * The resolver's input: continuous positions derived from cells through the one
 * conversion, defense ratings (never offense), and — the guardrail — no elevation, terrain
 * or scenery can be carried, in the type or in the data.
 */
import { FIXED_POINT_SCALE, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
import { describe, expect, it } from "vitest";
import {
  BATTLEFIELD_VERSION,
  CORE_CELLS,
  CORE_CENTER,
  assertBattlefield,
  canonicalJson,
  cellCenter,
  ringSegment,
  toBattlefield,
  type Battlefield,
  type BattlefieldPost,
  type Cell,
  type FixedPoint,
} from "../src/index.js";
import { arrange, fullPack } from "./fixtures.js";

describe("toBattlefield", () => {
  const m = fullPack();
  const f = arrange(m, 2);
  const b = toBattlefield(m, f);

  it("gives every placed object its lattice cell AND its continuous tick-zero position, via cellCenter", () => {
    for (const fence of b.fences) {
      expect(fence.cell).toEqual(ringSegment(fence.segment).cell);
      expect(fence.pos).toEqual(cellCenter(fence.cell));
      expect(fence.pos.x).toBe(fence.cell.x * FIXED_POINT_SCALE + 512);
    }
    for (const t of b.traps) expect(t.pos).toEqual(cellCenter(t.cell));
    for (const p of b.posts) expect(p.pos).toEqual(cellCenter(p.cell));
    expect(b.core.cells).toEqual(CORE_CELLS);
    expect(b.core.center).toEqual(CORE_CENTER);
    expect(b.grid).toEqual({ width: 32, height: 32 });
    expect(b.v).toBe(BATTLEFIELD_VERSION);
  });

  it("posted units carry post, aggro radius, leash and the DEFENSE rating scaled by merge level", () => {
    const coyote = b.posts.find((p) => p.ref === "u-coyote")!;
    const type = getUnitType("desert.coyote_pack")!;
    expect(coyote.mergeLevel).toBe(3);
    expect(coyote.defense).toBe(scaleInt(type.defense, mergeStatMult(3)));
    expect(coyote.aggroRadius).toBe(type.aggroRadius);
    expect(coyote.leashDistance).toBe(type.leashDistance);
    expect(coyote.hp).toBe(coyote.maxHp);
    expect((coyote as unknown as Record<string, unknown>)["offense"]).toBeUndefined();
    expect(Object.keys(coyote)).not.toContain("offense");
  });

  it("lists all four entry edges with their bands, in a fixed order", () => {
    expect(b.entries.map((e) => e.edge)).toEqual(["north", "east", "south", "west"]);
    for (const e of b.entries) expect(e.cells).toHaveLength(64);
  });

  it("is canonically ordered, integer-only, and passes its own shape guard", () => {
    expect(b.fences.map((x) => x.segment)).toEqual([...b.fences.map((x) => x.segment)].sort((p, q) => p - q));
    expect(b.posts.map((x) => x.ref)).toEqual([...b.posts.map((x) => x.ref)].sort());
    expect(() => assertBattlefield(JSON.parse(JSON.stringify(b)))).not.toThrow();
    // Numbers: no fraction anywhere once string values (flavour text) are stripped.
    const s = canonicalJson(JSON.parse(JSON.stringify(b))).replace(/"(?:\\.|[^"\\])*"/g, '""');
    expect(/\d\.\d/.test(s)).toBe(false);
    // Keys: nothing that smells of terrain or of the account side.
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    walk(JSON.parse(JSON.stringify(b)));
    expect([...keys].filter((k) => /elevation|terrain|scenery|cover|slope|account|coin|purchase|entitlement|offense/i.test(k))).toEqual([]);
  });

  it("throws on a formation that references something the manifest lacks", () => {
    expect(() => toBattlefield(m, { ...f, posts: [...f.posts, { ref: "u-ghost", cell: { x: 20, y: 20 } }] })).toThrow(/not in the manifest/);
  });
});

describe("the battlefield is flat: no elevation, terrain or scenery can be carried", () => {
  it("in the TYPE: an excess property on any level is a compile error", () => {
    const pos: FixedPoint = cellCenter({ x: 1, y: 1 });
    // @ts-expect-error — a cell is (x, y) and nothing else
    const cellWithHeight: Cell = { x: 1, y: 1, elevation: 3 };
    // @ts-expect-error — no z on a continuous position either
    const posWithZ: FixedPoint = { x: pos.x, y: pos.y, z: pos.x };
    const m = fullPack();
    const b = toBattlefield(m, arrange(m));
    // @ts-expect-error — terrain is not a battlefield field
    const withTerrain: Battlefield = { ...b, terrain: [] };
    // @ts-expect-error — scenery is not a battlefield field
    const withScenery: Battlefield = { ...b, scenery: [{ kind: "rock" }] };
    // @ts-expect-error — elevation is not a battlefield field
    const withElevation: Battlefield = { ...b, elevation: new Array(1024).fill(0) };
    // @ts-expect-error — no per-post cover either
    const postWithCover: BattlefieldPost = { ...b.posts[0]!, cover: 1 };
    // @ts-expect-error — and no account identity reaches the resolver
    const withAccount: Battlefield = { ...b, accountId: "x" };
    expect([cellWithHeight, posWithZ, withTerrain, withScenery, withElevation, postWithCover, withAccount].length).toBe(7);
  });

  it("in the DATA: the runtime guard refuses extra keys at every level by name", () => {
    const m = fullPack();
    const plain = JSON.parse(JSON.stringify(toBattlefield(m, arrange(m)))) as Record<string, unknown>;
    const mutated = (patch: (o: Record<string, unknown>) => void): unknown => {
      const o = JSON.parse(JSON.stringify(plain)) as Record<string, unknown>;
      patch(o);
      return o;
    };
    expect(() => assertBattlefield(mutated((o) => (o["elevation"] = [])))).toThrow(/unknown key 'elevation'/);
    expect(() => assertBattlefield(mutated((o) => (o["terrain"] = {})))).toThrow(/unknown key 'terrain'/);
    expect(() => assertBattlefield(mutated((o) => (o["scenery"] = [])))).toThrow(/unknown key 'scenery'/);
    expect(() => assertBattlefield(mutated((o) => ((o["grid"] as Record<string, unknown>)["elevation"] = [])))).toThrow(/grid carries unknown key 'elevation'/);
    expect(() => assertBattlefield(mutated((o) => ((o["core"] as Record<string, unknown>)["height"] = 2)))).toThrow(/core carries unknown key 'height'/);
    expect(() => assertBattlefield(mutated((o) => ((o["fences"] as Record<string, unknown>[])[0]!["cover"] = 1)))).toThrow(/fences\[0\] carries unknown key 'cover'/);
    expect(() => assertBattlefield(mutated((o) => ((o["traps"] as Record<string, unknown>[])[0]!["terrain"] = "mud")))).toThrow(/traps\[0\] carries unknown key 'terrain'/);
    expect(() => assertBattlefield(mutated((o) => ((o["posts"] as Record<string, unknown>[])[0]!["elevation"] = 1)))).toThrow(/posts\[0\] carries unknown key 'elevation'/);
    expect(() => assertBattlefield(mutated((o) => (((o["posts"] as Record<string, unknown>[])[0]!["cell"] as Record<string, unknown>)["z"] = 1)))).toThrow(/cell carries unknown key 'z'/);
    expect(() => assertBattlefield(mutated((o) => (((o["posts"] as Record<string, unknown>[])[0]!["pos"] as Record<string, unknown>)["z"] = 1)))).toThrow(/pos carries unknown key 'z'/);
    expect(() => assertBattlefield(mutated((o) => ((o["entries"] as Record<string, unknown>[])[0]!["slope"] = 1)))).toThrow(/entries\[0\] carries unknown key 'slope'/);
    expect(() => assertBattlefield(mutated((o) => (o["accountId"] = "x")))).toThrow(/unknown key 'accountId'/);
    expect(() => assertBattlefield(mutated((o) => (o["isPaying"] = true)))).toThrow(/unknown key 'isPaying'/);
    // And a float anywhere is refused too.
    expect(() => assertBattlefield(mutated((o) => (((o["posts"] as Record<string, unknown>[])[0]!["pos"] as Record<string, unknown>)["x"] = 1536.5)))).toThrow(/integer/);
    expect(() => assertBattlefield(mutated((o) => ((o["posts"] as Record<string, unknown>[])[0]!["defense"] = 70.25)))).toThrow(/integer/);
  });
});

describe("the resolver's mirrored content shapes agree with @caravan/content (chunk 10)", () => {
  it("fixed-point scale, affinity / fence / trap categories, ability archetypes and post stances are identical lists", async () => {
    const content = await import("@caravan/content");
    const resolver = await import("@caravan/resolver");
    expect(resolver.FIXED_POINT_SCALE).toBe(content.FIXED_POINT_SCALE);
    expect([...resolver.AFFINITY_CATEGORIES]).toEqual([...content.AFFINITY_CATEGORIES]);
    expect([...resolver.FENCE_CATEGORIES]).toEqual([...content.FENCE_CATEGORIES]);
    expect([...resolver.TRAP_CATEGORIES]).toEqual([...content.TRAP_CATEGORIES]);
    expect([...resolver.ABILITY_ARCHETYPES]).toEqual([...content.ABILITY_ARCHETYPES]);
    expect([...resolver.POST_STANCES]).toEqual(["guard", "hold", "reserve"]);
    expect([...resolver.STANCES]).toEqual(["nearest", "traps", "core"]);
    // The built battlefield carries the anchors and a default post stance, and the resolver's guard accepts it as-is.
    const m = fullPack();
    const b = toBattlefield(m, arrange(m));
    expect(b.anchors).toEqual(resolver.RING_ANCHORS);
    expect(b.posts.every((p) => p.stance === "guard")).toBe(true);
    expect(() => resolver.assertBattlefield(JSON.parse(JSON.stringify(b)))).not.toThrow();
  });

  it("resolverTunables() hands the registry's chunk 10 values to the resolver as plain integers, and the resolver accepts them", async () => {
    const { resolverTunables } = await import("../src/index.js");
    const { assertTunables, msToTicks } = await import("@caravan/resolver");
    const t = resolverTunables();
    expect(t).toEqual({ tickRate: 20, battleLengthCapSeconds: 180, pathRecomputeIntervalMs: 500, unitRadius: 358, keyframeIntervalMs: 5000, pathConnectivity: 4 });
    expect(() => assertTunables(t)).not.toThrow();
    expect(msToTicks(t.pathRecomputeIntervalMs, t.tickRate)).toBe(10);
    expect(msToTicks(t.keyframeIntervalMs, t.tickRate)).toBe(100);
    expect(t.battleLengthCapSeconds * t.tickRate).toBe(3600);
  });
});
