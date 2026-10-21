import { CORE_CENTER_CELL, EMPTY_FORMATION, formationGaps, ringSegment, validateFormation } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { packedManifest, survivorsManifest } from "../test/circleFixtures.ts";
import { fixtureScoutFor } from "../screens/trail/scoutFixture.ts";
import { applyMainFence, applyOpenGap, applyPosts, applyRestOfFence, applyTrap, arrangeStatus, gapSegment, guidedFormation, inwardFromGap, mainEdge, postTarget, raidersByEdge, sideSegments } from "./arrangeGuide.ts";

const scout = fixtureScoutFor(1); // 2 raiders north, 1 east
const west = fixtureScoutFor(2); // 4 west, 1 south

describe("the guided arrangement (chunk 24)", () => {
  it("reads the side most raiders start on, ties in ENTRY_EDGES order, and leaves its middle position open", () => {
    expect(raidersByEdge(scout)[0]).toEqual({ edge: "north", raiders: 2 });
    expect(mainEdge(scout)).toBe("north");
    expect(mainEdge(west)).toBe("west");
    expect(sideSegments("north")).toEqual([15, 0, 1]);
    expect(gapSegment("north")).toBe(0);
    expect(ringSegment(gapSegment("north")).cell).toEqual({ x: 17, y: 11 });
    expect(inwardFromGap("north", 1)).toEqual({ x: 17, y: 12 });
    expect(inwardFromGap("west", 2)).toEqual({ x: 12, y: 16 });
  });

  it("walks fence → gap → post → trap → rest, each step a legal arrangement by circle's own rules", () => {
    const m = packedManifest();
    let f = EMPTY_FORMATION;
    let s = arrangeStatus(m, f, scout);
    expect(s).toMatchObject({ edge: "north", raidersOnEdge: 2, raidersTotal: 3, gap: 0, fenceDone: false, gapOpen: true, postDone: false, unposted: 3, trapDone: false, trapAvailable: true, fenceLeft: TUNABLES.FENCE_MATERIAL_BUDGET });

    f = applyMainFence(m, f, scout);
    expect(f.fences.map((p) => p.segment).sort((a, b) => a - b)).toEqual([1, 15]);
    s = arrangeStatus(m, f, scout);
    expect(s.fenceDone).toBe(true);
    expect(s.gapOpen).toBe(true);
    expect(s.nextPost?.cell).toEqual({ x: 17, y: 13 });

    f = applyPosts(m, f, scout);
    expect(f.posts).toHaveLength(3);
    expect(f.posts[0]!.cell).toEqual({ x: 17, y: 13 });
    s = arrangeStatus(m, f, scout);
    expect(s.postDone).toBe(true);
    expect(s.unposted).toBe(0);
    expect(s.nextTrap?.cell).toEqual({ x: 17, y: 12 });

    f = applyTrap(m, f, scout);
    expect(f.traps).toEqual([{ ref: "t0", cell: { x: 17, y: 12 } }]);
    expect(arrangeStatus(m, f, scout).trapDone).toBe(true);

    f = applyRestOfFence(m, f, scout);
    expect(f.fences).toHaveLength(TUNABLES.FENCE_MATERIAL_BUDGET);
    expect(formationGaps(f)).toContain(0);
    expect(arrangeStatus(m, f, scout).fenceLeft).toBe(0);
    // Circle's own validator (what the server runs) accepts the guided circle.
    const v = validateFormation(m, f, () => true);
    expect(v.ok).toBe(true);
  });

  it("re-opens a gap the player fenced, and changes nothing when there is nothing to do", () => {
    const m = packedManifest();
    const all = applyRestOfFence(m, applyMainFence(m, EMPTY_FORMATION, scout), scout);
    // Fence the gap by hand: the guide's step 2 takes it back off.
    const spare = m.fences.find((x) => !all.fences.some((p) => p.ref === x.ref));
    expect(spare).toBeUndefined();
    const closed = { ...all, fences: all.fences.map((p, i) => (i === 0 ? { ...p, segment: 0 } : p)) };
    expect(arrangeStatus(m, closed, scout).gapOpen).toBe(false);
    const reopened = applyOpenGap(closed, scout);
    expect(arrangeStatus(m, reopened, scout).gapOpen).toBe(true);
    expect(applyOpenGap(reopened, scout)).toBe(reopened);
    expect(applyMainFence(m, all, scout)).toBe(all);
  });

  it("carries attrition: a dead unit is not posted, a spent trap is not laid, a destroyed segment is not placed", () => {
    const m = survivorsManifest(); // u-digger dead, t0 spent, f0 destroyed
    let f = applyPosts(m, applyMainFence(m, EMPTY_FORMATION, scout), scout);
    expect(f.posts.map((p) => p.ref).sort()).toEqual(["u-canteen", "u-rider"]);
    f = applyTrap(m, f, scout);
    expect(f.traps.map((t) => t.ref)).toEqual(["t1"]);
    f = applyRestOfFence(m, f, scout);
    expect(f.fences.some((p) => p.ref === "f0")).toBe(false);
    expect(f.fences).toHaveLength(TUNABLES.FENCE_MATERIAL_BUDGET - 1);
    expect(validateFormation(m, f, () => true).ok).toBe(true);
  });

  it("round 3: guidedFormation (the shared layout the harness models) is exactly the checklist's buttons in order, on survivors and on the chosen party's side", () => {
    for (const [m, sc] of [
      [packedManifest(), scout],
      [survivorsManifest(), scout],
      [survivorsManifest(), west],
    ] as const) {
      const stepwise = applyRestOfFence(m, applyTrap(m, applyPosts(m, applyOpenGap(applyMainFence(m, EMPTY_FORMATION, sc), sc), sc), sc), sc);
      const whole = guidedFormation(m, sc);
      expect(whole).toEqual(stepwise);
      expect(validateFormation(m, whole, () => true).ok).toBe(true);
      // The gap on the chosen party's main side stays open.
      expect(whole.fences.some((p) => p.segment === gapSegment(mainEdge(sc)))).toBe(false);
    }
    // A pushed encounter from the west: the gap moves to the west side's middle.
    expect(guidedFormation(survivorsManifest(), west).posts[0]!.cell).toEqual(inwardFromGap("west", 2));
  });
});

describe("round ring: posts spread over the threatened edges, the rest of the fence nearest the raiders", () => {
  it("postTarget: unit 0 behind the main gap, the next threatened edge at the core centre moved two cells toward it", () => {
    expect(postTarget(scout, 0)).toEqual(inwardFromGap("north", 2));
    expect(postTarget(scout, 1)).toEqual({ x: CORE_CENTER_CELL.x + 2, y: CORE_CENTER_CELL.y }); // east: the core centre + 2 in x
    expect(postTarget(scout, 2)).toEqual(postTarget(scout, 0));
  });

  it("the guided posts put unit 0 north and unit 1 east of the core, a third back on the main edge", () => {
    const f = applyPosts(packedManifest(), EMPTY_FORMATION, scout);
    expect(f.posts).toHaveLength(3);
    expect(f.posts[0]!.cell).toEqual({ x: 17, y: 13 });
    expect(f.posts[1]!.cell.x).toBeGreaterThan(CORE_CENTER_CELL.x);
    expect(f.posts[2]!.cell.y).toBeLessThan(CORE_CENTER_CELL.y);
  });

  it("nextPost, once one unit is posted, targets the second threatened edge", () => {
    const m = packedManifest();
    const f = { ...EMPTY_FORMATION, posts: [{ ref: m.units[0]!.ref, cell: { x: 17, y: 13 }, stance: "guard" as const }] };
    const next = arrangeStatus(m, f, scout).nextPost!;
    expect(next.ref).toBe(m.units[1]!.ref);
    expect(next.cell.x).toBeGreaterThan(CORE_CENTER_CELL.x);
  });

  it("a north-only scout leaves the far (south) side of the ring open", () => {
    const m = packedManifest();
    const north = { units: [{ edge: "north" as const }, { edge: "north" as const }], edges: ["north" as const] };
    const f = applyRestOfFence(m, applyOpenGap(applyMainFence(m, EMPTY_FORMATION, north), north), north);
    expect(f.fences).toHaveLength(TUNABLES.FENCE_MATERIAL_BUDGET);
    const fenced = new Set(f.fences.map((p) => p.segment));
    const open = [...Array(16).keys()].filter((i) => !fenced.has(i) && i !== gapSegment("north"));
    expect(open.length).toBeGreaterThan(0);
    for (const i of open) expect(ringSegment(i).cell.y).toBeGreaterThan(CORE_CENTER_CELL.x);
  });
});
