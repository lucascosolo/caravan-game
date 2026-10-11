import { EMPTY_FORMATION, formationGaps, ringSegment, validateFormation } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { packedManifest, survivorsManifest } from "../test/circleFixtures.ts";
import { fixtureScoutFor } from "../screens/trail/scoutFixture.ts";
import { applyMainFence, applyOpenGap, applyPosts, applyRestOfFence, applyTrap, arrangeStatus, gapSegment, inwardFromGap, mainEdge, raidersByEdge, sideSegments } from "./arrangeGuide.ts";

const scout = fixtureScoutFor(1); // 2 raiders north, 1 east
const west = fixtureScoutFor(2); // 4 west, 1 south

describe("the guided arrangement (chunk 24)", () => {
  it("reads the side most raiders start on, ties in ENTRY_EDGES order, and leaves its middle position open", () => {
    expect(raidersByEdge(scout)[0]).toEqual({ edge: "north", raiders: 2 });
    expect(mainEdge(scout)).toBe("north");
    expect(mainEdge(west)).toBe("west");
    expect(sideSegments("north")).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(gapSegment("north")).toBe(3);
    expect(ringSegment(gapSegment("north")).cell).toEqual({ x: 15, y: 11 });
    expect(inwardFromGap("north", 1)).toEqual({ x: 15, y: 12 });
    expect(inwardFromGap("west", 2)).toEqual({ x: 13, y: 15 });
  });

  it("walks fence → gap → post → trap → rest, each step a legal arrangement by circle's own rules", () => {
    const m = packedManifest();
    let f = EMPTY_FORMATION;
    let s = arrangeStatus(m, f, scout);
    expect(s).toMatchObject({ edge: "north", raidersOnEdge: 2, raidersTotal: 3, gap: 3, fenceDone: false, gapOpen: true, postDone: false, unposted: 3, trapDone: false, trapAvailable: true, fenceLeft: TUNABLES.FENCE_MATERIAL_BUDGET });

    f = applyMainFence(m, f, scout);
    expect(f.fences.map((p) => p.segment).sort((a, b) => a - b)).toEqual([0, 1, 2, 4, 5, 6]);
    s = arrangeStatus(m, f, scout);
    expect(s.fenceDone).toBe(true);
    expect(s.gapOpen).toBe(true);
    expect(s.nextPost?.cell).toEqual({ x: 15, y: 13 });

    f = applyPosts(m, f, scout);
    expect(f.posts).toHaveLength(3);
    expect(f.posts[0]!.cell).toEqual({ x: 15, y: 13 });
    s = arrangeStatus(m, f, scout);
    expect(s.postDone).toBe(true);
    expect(s.unposted).toBe(0);
    expect(s.nextTrap?.cell).toEqual({ x: 15, y: 12 });

    f = applyTrap(m, f, scout);
    expect(f.traps).toEqual([{ ref: "t0", cell: { x: 15, y: 12 } }]);
    expect(arrangeStatus(m, f, scout).trapDone).toBe(true);

    f = applyRestOfFence(m, f, scout);
    expect(f.fences).toHaveLength(TUNABLES.FENCE_MATERIAL_BUDGET);
    expect(formationGaps(f)).toContain(3);
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
    const closed = { ...all, fences: all.fences.map((p, i) => (i === 0 ? { ...p, segment: 3 } : p)) };
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
});
