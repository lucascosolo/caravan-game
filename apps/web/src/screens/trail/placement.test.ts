import { EMPTY_FORMATION, RING_ANCHORS, RING_SEGMENTS, CORE_CELLS, ringSegment, formationGaps } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { packedManifest, survivorsManifest } from "../../test/circleFixtures.ts";
import {
  canDropAt,
  dropAt,
  edgeReports,
  fenceBudget,
  fenceRuns,
  isPlaceableCell,
  itemize,
  nextFenceRef,
  placeFence,
  placePost,
  placeTrap,
  remove,
  setStance,
  unplacedFences,
  unplacedTraps,
  unpostedUnits,
} from "./placement.ts";
import { fixtureScoutFor } from "./scoutFixture.ts";

const inner = { x: 12, y: 12 }; // inside the ring, off the core
const inner2 = { x: 13, y: 18 };

describe("placement model", () => {
  it("only offers what survives: dead units, spent traps and destroyed segments are not placeable", () => {
    const m = survivorsManifest();
    expect(unpostedUnits(m, EMPTY_FORMATION).map((u) => u.ref)).toEqual(["u-rider", "u-canteen"]);
    expect(unplacedTraps(m, EMPTY_FORMATION).map((t) => t.ref)).toEqual(["t1"]);
    expect(unplacedFences(m, EMPTY_FORMATION).some((f) => f.ref === "f0")).toBe(false);
    // Healthiest first, so the chipped f1 comes last.
    const order = unplacedFences(m, EMPTY_FORMATION);
    expect(order[order.length - 1]!.ref).toBe("f1");
    expect(nextFenceRef(m, EMPTY_FORMATION)).not.toBe("f1");
  });

  it("the budget meter counts remaining / placed / destroyed / packed and the ring is bigger than the budget", () => {
    const m = survivorsManifest();
    const b0 = fenceBudget(m, EMPTY_FORMATION);
    expect(b0).toEqual({ packed: TUNABLES.FENCE_MATERIAL_BUDGET, destroyed: 1, placed: 0, remaining: TUNABLES.FENCE_MATERIAL_BUDGET - 1, ring: RING_SEGMENTS.length });
    expect(b0.ring).toBeGreaterThan(b0.packed);
    const f = placeFence(EMPTY_FORMATION, nextFenceRef(m, EMPTY_FORMATION)!, 3);
    expect(fenceBudget(m, f).placed).toBe(1);
    expect(fenceBudget(m, f).remaining).toBe(b0.remaining - 1);
  });

  it("places a fence on a ring position, refuses a taken position, and moves it on re-drop", () => {
    const f1 = placeFence(EMPTY_FORMATION, "f2", 5);
    expect(f1.fences).toEqual([{ ref: "f2", segment: 5 }]);
    expect(placeFence(f1, "f3", 5)).toBe(f1);
    const moved = placeFence(f1, "f2", 9);
    expect(moved.fences).toEqual([{ ref: "f2", segment: 9 }]);
  });

  it("refuses the ring, the anchors, the core and the entry bands for traps and posts", () => {
    expect(isPlaceableCell(ringSegment(0).cell)).toBe(false);
    expect(isPlaceableCell(RING_ANCHORS[0]!)).toBe(false);
    expect(isPlaceableCell(CORE_CELLS[4]!)).toBe(false);
    expect(isPlaceableCell({ x: 5, y: 0 })).toBe(false);
    expect(isPlaceableCell({ x: 31, y: 5 })).toBe(false);
    expect(isPlaceableCell({ x: 40, y: 5 })).toBe(false);
    expect(isPlaceableCell(inner)).toBe(true);
  });

  it("no two things on one cell; a post keeps MIN_POST_DISTANCE; moving a thing frees its old cell", () => {
    const f1 = placeTrap(EMPTY_FORMATION, "t1", inner);
    expect(placePost(f1, "u-rider", inner)).toBe(f1);
    const f2 = placePost(f1, "u-rider", inner2);
    expect(f2.posts).toEqual([{ ref: "u-rider", cell: inner2, stance: "guard" }]);
    const f3 = placePost(f2, "u-rider", { x: 20, y: 20 });
    expect(f3.posts[0]!.cell).toEqual({ x: 20, y: 20 });
    expect(placeTrap(f3, "t0", inner2).traps).toHaveLength(2);
  });

  it("sets and keeps a stance across a move; removal returns the thing to the wagon", () => {
    const f1 = setStance(placePost(EMPTY_FORMATION, "u-rider", inner), "u-rider", "reserve");
    expect(f1.posts[0]!.stance).toBe("reserve");
    expect(placePost(f1, "u-rider", inner2).posts[0]!.stance).toBe("reserve");
    expect(setStance(EMPTY_FORMATION, "u-rider", "hold")).toBe(EMPTY_FORMATION);
    const m = packedManifest();
    expect(unpostedUnits(m, remove(f1, "u-rider")).map((u) => u.ref)).toContain("u-rider");
  });

  it("dropAt routes by kind: a fence wants a ring cell, a unit a free cell; canDropAt agrees", () => {
    const m = packedManifest();
    expect(canDropAt(m, EMPTY_FORMATION, "f2", ringSegment(7).cell)).toBe(true);
    expect(canDropAt(m, EMPTY_FORMATION, "f2", inner)).toBe(false);
    expect(canDropAt(m, EMPTY_FORMATION, "u-rider", ringSegment(7).cell)).toBe(false);
    expect(canDropAt(m, EMPTY_FORMATION, "u-rider", inner)).toBe(true);
    expect(canDropAt(m, EMPTY_FORMATION, "nope", inner)).toBe(false);
    const f = dropAt(m, dropAt(m, EMPTY_FORMATION, "f2", ringSegment(7).cell), "u-rider", inner);
    expect(f.fences).toEqual([{ ref: "f2", segment: 7 }]);
    expect(f.posts[0]!.ref).toBe("u-rider");
    expect(dropAt(m, f, "f3", inner)).toBe(f);
  });

  it("a gapped ring is never an issue here: gaps are counted, grouped and reported per edge, with the party's approach", () => {
    const m = packedManifest();
    let f = EMPTY_FORMATION;
    m.fences.forEach((x, i) => (f = placeFence(f, x.ref, i)));
    expect(formationGaps(f)).toHaveLength(RING_SEGMENTS.length - TUNABLES.FENCE_MATERIAL_BUDGET);
    expect(fenceRuns(f)).toEqual([{ from: 0, to: TUNABLES.FENCE_MATERIAL_BUDGET - 1 }]);
    const party = fixtureScoutFor(1);
    const reports = edgeReports(m, f, party);
    expect(reports.map((r) => r.edge)).toEqual(["north", "east", "south", "west"]);
    expect(reports.reduce((s, r) => s + r.gaps, 0)).toBe(formationGaps(f).length);
    expect(reports.reduce((s, r) => s + r.attackers, 0)).toBe(party.units.length);
    // A guard posted just inside the west side watches it; nothing watches the east.
    const withPost = placePost(f, "u-rider", { x: 12, y: 15 });
    const r2 = edgeReports(m, withPost, party);
    expect(r2.find((r) => r.edge === "west")!.postsWatching).toBe(1);
    expect(r2.find((r) => r.edge === "east")!.postsWatching).toBe(0);
  });

  it("itemizes every placed thing for the commit confirmation, in canonical order", () => {
    const m = packedManifest();
    const f = placePost(placeTrap(placeFence(placeFence(EMPTY_FORMATION, "f3", 4), "f2", 1), "t1", inner), "u-rider", inner2, "hold");
    const items = itemize(m, f);
    expect(items.map((i) => `${i.kind}:${i.ref}`)).toEqual(["fence:f2", "fence:f3", "trap:t1", "post:u-rider"]);
    expect(items[3]!.detail).toContain("hold");
    expect(items[0]!.where).toContain("north");
  });
});
