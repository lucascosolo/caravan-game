/**
 * Final play-test review S3 / N14: the fast-arranging helpers in placement.ts — "Fence this
 * side", the picker's auto-advance, the tap-to-ring snap, "Start from my last arrangement"
 * and the commit dialog's by-side line. Pure; each edit goes through circle's own drop rules.
 */
import { EMPTY_FORMATION, RING_SEGMENTS, ringSegment, validateFormation } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { packedManifest, survivorsManifest } from "../../test/circleFixtures.ts";
import { fenceSide, fencesBySide, nextUnplacedOfKind, openOnSide, placeFence, placePost, placeTrap, setStance, sidePositions, snapToRing } from "./placement.ts";

describe("quick arrange (final play-test review S3)", () => {
  it("Fence this side closes every open position on that side with the next segments, healthiest first", () => {
    const m = survivorsManifest();
    const f = fenceSide(m, EMPTY_FORMATION, "west");
    expect(openOnSide(f, "west")).toBe(0);
    expect(f.fences.map((p) => p.segment).sort((a, b) => a - b)).toEqual([...sidePositions("west")].sort((a, b) => a - b));
    // Destroyed f0 is never used; the chipped f1 goes last (not on a 5-position side with healthy ones left).
    expect(f.fences.some((p) => p.ref === "f0" || p.ref === "f1")).toBe(false);
    expect(validateFormation(m, placePost(placePost(f, "u-rider", { x: 12, y: 12 }), "u-canteen", { x: 13, y: 18 }), () => true).ok).toBe(true);
    // A side already partly fenced keeps what is there and fills the rest.
    const north = placeFence(EMPTY_FORMATION, "f2", sidePositions("north")[0]!);
    expect(openOnSide(fenceSide(m, north, "north"), "north")).toBe(0);
  });

  it("stops when the wagon is empty", () => {
    const m = packedManifest();
    let f = EMPTY_FORMATION;
    for (const e of ["north", "east", "south", "west"] as const) f = fenceSide(m, f, e);
    expect(f.fences).toHaveLength(TUNABLES.FENCE_MATERIAL_BUDGET);
    expect(RING_SEGMENTS.length - f.fences.length).toBe(RING_SEGMENTS.length - TUNABLES.FENCE_MATERIAL_BUDGET);
  });

  it("the picker's auto-advance: the next segment, the next unposted living unit, the next unlaid trap", () => {
    const m = survivorsManifest();
    const f1 = placeFence(EMPTY_FORMATION, "f2", 3);
    const next = nextUnplacedOfKind(m, f1, "f2");
    expect(next).not.toBe("f2");
    expect(next).not.toBeNull();
    // u-digger is dead, so after u-rider the next unit is u-canteen; after both, none.
    const p1 = placePost(EMPTY_FORMATION, "u-rider", { x: 12, y: 12 });
    expect(nextUnplacedOfKind(m, p1, "u-rider")).toBe("u-canteen");
    expect(nextUnplacedOfKind(m, placePost(p1, "u-canteen", { x: 13, y: 18 }), "u-canteen")).toBeNull();
    // t0 is spent: laying t1 leaves nothing.
    expect(nextUnplacedOfKind(m, placeTrap(EMPTY_FORMATION, "t1", { x: 14, y: 12 }), "t1")).toBeNull();
  });

  it("a tap next to the ring snaps to the nearest ring position; a tap far from it does not", () => {
    const seg = ringSegment(0).cell;
    expect(snapToRing(seg)).toEqual(seg);
    expect(snapToRing({ x: seg.x, y: seg.y - 1 })).toEqual(seg);
    expect(snapToRing({ x: seg.x, y: seg.y + 1 })).toEqual(seg);
    expect(snapToRing({ x: 15, y: 15 })).toBeNull();
    expect(snapToRing({ x: 2, y: 2 })).toBeNull();
  });

  it("the commit dialog's by-side line counts fenced and open positions per side (N14)", () => {
    const f = fenceSide(packedManifest(), EMPTY_FORMATION, "north");
    const by = fencesBySide(f);
    expect(by.find((s) => s.edge === "north")).toEqual({ edge: "north", placed: 3, open: 0 });
    expect(by.find((s) => s.edge === "west")).toEqual({ edge: "west", placed: 0, open: 5 });
  });
});
