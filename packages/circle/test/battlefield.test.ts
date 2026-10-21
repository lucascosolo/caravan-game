/**
 * The resolver's input: continuous positions derived from cells through the one
 * conversion, defense ratings (never offense), and — the guardrail — no elevation, terrain
 * or scenery can be carried, in the type or in the data.
 */
import { FIXED_POINT_SCALE, TUNABLES, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
import { describe, expect, it } from "vitest";
import {
  BATTLEFIELD_VERSION,
  CORE_CELLS,
  CORE_CENTER,
  DEFENSIVE_STANCES,
  RING_ANCHORS,
  assertBattlefield,
  canonicalJson,
  cellCenter,
  cellKey,
  entryBand,
  isAnchorCell,
  packManifest,
  resolveParty,
  ringSegment,
  scoutParty,
  toBattlefield,
  type Battlefield,
  type BattlefieldPost,
  type Cell,
  type FixedPoint,
  type Formation,
} from "../src/index.js";
import { ALLOW_ALL, arrange, fullPack } from "./fixtures.js";

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
    expect(BATTLEFIELD_VERSION).toBe(3);
  });

  it("QA D2: carries the twelve wagon cells (six two-cell wagons) as blocked cells and the 4-connected pathing rule", () => {
    expect(b.anchors).toEqual(RING_ANCHORS);
    expect(b.anchors).toHaveLength(12);
    expect(b.pathConnectivity).toBe(4);
    for (const a of b.anchors) expect(isAnchorCell(a)).toBe(true);
    // No fence, trap or post ever shares a cell with an anchor.
    const placed = [...b.fences, ...b.traps, ...b.posts].map((o) => cellKey(o.cell));
    for (const a of b.anchors) expect(placed).not.toContain(cellKey(a));
  });

  it("QA D1: every post carries its defensive stance through to the resolver", () => {
    const withStances: Formation = { ...f, posts: f.posts.map((p, i) => ({ ...p, stance: DEFENSIVE_STANCES[i % 3]! })) };
    const bf = toBattlefield(m, withStances);
    for (const p of bf.posts) expect(p.stance).toBe(withStances.posts.find((q) => q.ref === p.ref)!.stance);
    expect(new Set(bf.posts.map((p) => p.stance))).toEqual(new Set(["guard", "hold", "reserve"]));
    expect(() => assertBattlefield(JSON.parse(JSON.stringify(bf)))).not.toThrow();
  });

  it("posted units carry post, aggro radius, leash and the UNMERGED defense rating (chunk 03 QA B1: merge scales HP and damage output in the resolver, never a rating)", () => {
    const coyote = b.posts.find((p) => p.ref === "u-coyote")!;
    const type = getUnitType("desert.coyote_pack")!;
    expect(coyote.mergeLevel).toBe(3);
    expect(coyote.defense).toBe(type.defense);
    expect(coyote.defense).not.toBe(scaleInt(type.defense, mergeStatMult(3)));
    expect(coyote.maxHp).toBe(scaleInt(type.hp, mergeStatMult(3)));
    expect(coyote.aggroRadius).toBe(type.aggroRadius);
    expect(coyote.leashDistance).toBe(type.leashDistance);
    expect(coyote.hp).toBe(coyote.maxHp);
    expect((coyote as unknown as Record<string, unknown>)["offense"]).toBeUndefined();
    expect(Object.keys(coyote)).not.toContain("offense");
  });

  it("chunk 03 QA B1 / chunk 09 QA X1: at EVERY merge level the battlefield rating equals the unscaled type rating; only HP scales", () => {
    for (let level = TUNABLES.MERGE_LEVEL_MIN; level <= TUNABLES.MERGE_LEVEL_MAX; level++) {
      const res = packManifest(
        { units: [{ instanceId: "u-x", typeId: "desert.coyote_pack", mergeLevel: level }], traps: [], fence: { tierId: "fence.brush_pile", count: 1 } },
        ALLOW_ALL,
      );
      if (!res.ok) throw new Error(JSON.stringify(res.issues));
      const bf = toBattlefield(res.value, arrange(res.value));
      const post = bf.posts[0]!;
      const type = getUnitType("desert.coyote_pack")!;
      expect(post.mergeLevel).toBe(level);
      expect(post.defense).toBe(type.defense);
      expect(post.maxHp).toBe(scaleInt(type.hp, mergeStatMult(level)));
      expect(Object.keys(post)).not.toContain("offense");
    }
    // The scouting view's offense (the raiding side) is likewise the unscaled rating.
    const party = resolveParty(
      { v: 1, units: [{ ref: "r", stance: "nearest", edge: "north", cell: entryBand("north")[0]! }], siege: [] },
      [{ instanceId: "r", typeId: "desert.coyote_pack", mergeLevel: 5 }],
      ALLOW_ALL,
    );
    if (!party.ok) throw new Error(JSON.stringify(party.issues));
    const scouted = scoutParty(party.value).units[0]!;
    expect(scouted.offense).toBe(getUnitType("desert.coyote_pack")!.offense);
    expect(scouted.defense).toBe(getUnitType("desert.coyote_pack")!.defense);
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
    expect(() => toBattlefield(m, { ...f, posts: [...f.posts, { ref: "u-ghost", cell: { x: 20, y: 20 }, stance: "guard" }] })).toThrow(/not in the manifest/);
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

  it("QA S1: the nested content shapes are closed too — nothing hides inside an ability or a trap effect", () => {
    const m = fullPack();
    const plain = JSON.parse(JSON.stringify(toBattlefield(m, arrange(m)))) as Record<string, unknown>;
    const mutated = (patch: (o: Record<string, unknown>) => void): unknown => {
      const o = JSON.parse(JSON.stringify(plain)) as Record<string, unknown>;
      patch(o);
      return o;
    };
    const post = (o: Record<string, unknown>, i = 0) => (o["posts"] as Record<string, unknown>[])[i]!;
    const trap = (o: Record<string, unknown>, i = 0) => (o["traps"] as Record<string, unknown>[])[i]!;
    const fence = (o: Record<string, unknown>, i = 0) => (o["fences"] as Record<string, unknown>[])[i]!;
    expect(() => assertBattlefield(mutated((o) => ((post(o)["ability"] as Record<string, unknown>)["elevation"] = 7)))).toThrow(/posts\[0\]\.ability carries unknown key 'elevation'/);
    expect(() => assertBattlefield(mutated((o) => ((post(o)["ability"] as Record<string, unknown>)["archetype"] = "nuke")))).toThrow(/archetype nuke is not an ability archetype/);
    // A key that belongs to ANOTHER archetype is still unknown for this one.
    const heavy = (plain["posts"] as Record<string, unknown>[]).findIndex((p) => (p["ability"] as Record<string, unknown>)["archetype"] === "heavy_strike");
    expect(heavy).toBeGreaterThanOrEqual(0);
    expect(() => assertBattlefield(mutated((o) => ((post(o, heavy)["ability"] as Record<string, unknown>)["radius"] = 1024)))).toThrow(/ability carries unknown key 'radius'/);
    expect(() => assertBattlefield(mutated((o) => delete (post(o)["ability"] as Record<string, unknown>)["cooldown"]))).toThrow(/ability is missing 'cooldown'/);
    const withEffect = (plain["traps"] as Record<string, unknown>[]).findIndex((t) => t["effect"] !== null);
    expect(withEffect).toBeGreaterThanOrEqual(0);
    expect(() => assertBattlefield(mutated((o) => ((trap(o, withEffect)["effect"] as Record<string, unknown>)["terrain"] = 1)))).toThrow(/effect carries unknown key 'terrain'/);
    expect(() => assertBattlefield(mutated((o) => ((trap(o, withEffect)["effect"] as Record<string, unknown>)["kind"] = "stun")))).toThrow(/effect.kind stun is not a trap effect/);
    expect(() => assertBattlefield(mutated((o) => (trap(o, withEffect)["effect"] = [])))).toThrow(/effect must be an object or null/);
    // Enum-valued fields are checked against the content enums.
    expect(() => assertBattlefield(mutated((o) => ((o["entries"] as Record<string, unknown>[])[0]!["edge"] = "up")))).toThrow(/edge up is not an entry edge/);
    expect(() => assertBattlefield(mutated((o) => (post(o)["affinity"] = "cover")))).toThrow(/affinity cover is not an affinity/);
    expect(() => assertBattlefield(mutated((o) => (post(o)["stance"] = "attack")))).toThrow(/stance attack is not a defensive stance/);
    expect(() => assertBattlefield(mutated((o) => (trap(o)["category"] = "magic")))).toThrow(/category magic is not a trap category/);
    expect(() => assertBattlefield(mutated((o) => (trap(o)["affinity"] = "void")))).toThrow(/affinity void is not an affinity/);
    expect(() => assertBattlefield(mutated((o) => (fence(o)["category"] = "forcefield")))).toThrow(/category forcefield is not a fence category/);
    // Positions must lie on the field; hp within 0..maxHp.
    expect(() => assertBattlefield(mutated((o) => (post(o)["pos"] = { x: 999_999, y: 5 })))).toThrow(/is off the field/);
    expect(() => assertBattlefield(mutated((o) => (post(o)["pos"] = { x: 5, y: -5 })))).toThrow(/is off the field/);
    expect(() => assertBattlefield(mutated((o) => (post(o)["pos"] = { x: 32 * FIXED_POINT_SCALE, y: 5 })))).toThrow(/is off the field/);
    expect(() => assertBattlefield(mutated((o) => (post(o)["hp"] = (post(o)["maxHp"] as number) + 1)))).toThrow(/not within 0..maxHp/);
    expect(() => assertBattlefield(mutated((o) => (fence(o)["hp"] = -1)))).toThrow(/not within 0..maxHp/);
    // The lattice-level invariants are pinned too.
    expect(() => assertBattlefield(mutated((o) => (o["pathConnectivity"] = 8)))).toThrow(/pathConnectivity must be 4/);
    expect(() => assertBattlefield(mutated((o) => (o["anchors"] = [])))).toThrow(/anchors must list the 12 wagon cells/);
    expect(() => assertBattlefield(mutated((o) => (o["entries"] = (o["entries"] as unknown[]).slice(1))))).toThrow(/entries must list all 4 edges/);
    expect(() => assertBattlefield(mutated((o) => ((o["grid"] as Record<string, unknown>)["width"] = 64)))).toThrow(/grid is not 32/);
    expect(() => assertBattlefield(mutated((o) => (o["v"] = 1)))).toThrow(/version 1/);
    // The unmodified battlefield still passes after all of that.
    expect(() => assertBattlefield(mutated(() => undefined))).not.toThrow();
  });
});

describe("the resolver's mirrored content shapes agree with @caravan/content (chunk 10)", () => {
  it("QA-10 S4: every content unit type's moveSpeed clears the tick rate, and every magnitude sits inside the resolver's input bounds", async () => {
    const content = await import("@caravan/content");
    const resolver = await import("@caravan/resolver");
    const speeds = content.LIVING_UNIT_TYPES.map((u) => u.moveSpeed as number);
    expect(Math.min(...speeds), "the slowest unit would floor to 0 per tick").toBeGreaterThanOrEqual(content.TUNABLES.TICK_RATE);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(resolver.INPUT_BOUNDS.maxMoveSpeed);
    for (const u of content.LIVING_UNIT_TYPES) {
      expect(u.attackCooldown as number).toBeLessThanOrEqual(resolver.INPUT_BOUNDS.maxMillis);
      expect(u.attackRange as number).toBeLessThanOrEqual(resolver.INPUT_BOUNDS.maxDistance);
    }
    expect(content.TUNABLES.TICK_RATE).toBeLessThanOrEqual(resolver.INPUT_BOUNDS.maxTickRate);
  });

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

  it("resolverTunables() hands the registry's chunk 10 and 11 values to the resolver as plain integers, and the resolver accepts them", async () => {
    const { resolverTunables } = await import("../src/index.js");
    const { assertTunables, msToTicks } = await import("@caravan/resolver");
    const { AFFINITY_MATRIX, TUNABLES } = await import("@caravan/content");
    const t = resolverTunables();
    expect(t).toEqual({
      tickRate: 20,
      battleLengthCapSeconds: 180,
      pathRecomputeIntervalMs: 500,
      unitRadius: 358,
      keyframeIntervalMs: 5000,
      pathConnectivity: 4,
      affinityAdvantageMult: 1280,
      affinityDisadvantageMult: 819,
      affinityNeutralMult: 1024,
      affinityMatrix: {
        grit: { grit: "neutral", powder: "advantage", beast: "disadvantage" },
        powder: { grit: "disadvantage", powder: "neutral", beast: "advantage" },
        beast: { grit: "advantage", powder: "disadvantage", beast: "neutral" },
      },
      mergeStatMultByLevel: [0, 1024, 1280, 1600, 2000, 2500],
      trapTriggerRadius: 1280,
      siegeFenceDamageMult: 4096,
      leashHysteresisMult: 819,
      abilityFirstUseDelayMult: 1024,
      structureBreakerFirstUseMult: 256,
      fenceHitSegmentCap: 512,
    });
    expect(t.affinityMatrix).toEqual(AFFINITY_MATRIX);
    expect(t.mergeStatMultByLevel).toEqual([...TUNABLES.MERGE_STAT_MULT_BY_LEVEL]);
    expect(t.mergeStatMultByLevel.length).toBe(TUNABLES.MERGE_LEVEL_MAX + 1);
    // Plain data: the resolver's copy is not content's frozen object.
    expect(t.affinityMatrix).not.toBe(AFFINITY_MATRIX);
    expect(() => assertTunables(t)).not.toThrow();
    expect(msToTicks(t.pathRecomputeIntervalMs, t.tickRate)).toBe(10);
    expect(msToTicks(t.keyframeIntervalMs, t.tickRate)).toBe(100);
    expect(t.battleLengthCapSeconds * t.tickRate).toBe(3600);
  });
});
