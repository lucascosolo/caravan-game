import { EMPTY_FORMATION, RING_ANCHORS, RING_SEGMENTS, CORE_CELLS, ringSegment, formationGaps } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { packedManifest, survivorsManifest } from "../../test/circleFixtures.ts";
import { resolverTunables, toBattlefield, type Formation } from "@caravan/circle";
import { FIXED_POINT_SCALE } from "@caravan/content";
import {
  canDropAt,
  dropRefusal,
  pickerOptions,
  postReach,
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
    expect(items[3]!.detail).toContain("Hold");
    expect(items[0]!.where).toContain("North");
    // QA S15: player wording only — no raw refs, no lowercase enum ids.
    for (const i of items) expect(`${i.where} ${i.detail}`).not.toMatch(/\b(f\d+|t\d+|u-[a-z]+|north|hold|guard)\b/);
  });

  it("S9/N6: refusals are circle's own rules and codes; MIN_POST_DISTANCE binds posts only", () => {
    const m = packedManifest();
    expect(dropRefusal(m, EMPTY_FORMATION, "u-rider", CORE_CELLS[0]!)?.code).toBe("cell_reserved");
    expect(dropRefusal(m, EMPTY_FORMATION, "u-rider", RING_ANCHORS[0]!)?.code).toBe("cell_reserved");
    expect(dropRefusal(m, EMPTY_FORMATION, "f2", inner)?.code).toBe("bad_segment");
    expect(dropRefusal(m, placeFence(EMPTY_FORMATION, "f3", 5), "f2", ringSegment(5).cell)?.code).toBe("duplicate_segment");
    expect(dropRefusal(m, placeTrap(EMPTY_FORMATION, "t1", inner), "u-rider", inner)?.code).toBe("cell_occupied");
    expect(dropRefusal(m, EMPTY_FORMATION, "u-rider", { x: 40, y: 3 })?.code).toBe("bad_cell");
    expect(dropRefusal(m, EMPTY_FORMATION, "u-rider", inner)).toBeNull();
    // Messages are the player's wording, never a raw ref.
    expect(dropRefusal(m, EMPTY_FORMATION, "u-rider", CORE_CELLS[0]!)?.message).not.toMatch(/u-rider/);
    // A trap beside a post is never refused for distance; a second post as close is refused iff MIN_POST_DISTANCE says so.
    const withPost = placePost(EMPTY_FORMATION, "u-rider", inner);
    const adjacent = { x: inner.x + 1, y: inner.y };
    expect(dropRefusal(m, withPost, "t1", adjacent)).toBeNull();
    const minCells = TUNABLES.MIN_POST_DISTANCE / FIXED_POINT_SCALE;
    expect(dropRefusal(m, withPost, "u-canteen", adjacent)?.code ?? null).toBe(1 < minCells ? "post_too_close" : null);
  });

  it("B2/N11: post reach is the resolver's — the battlefield's radii plus UNIT_RADIUS — and reserve counts by attack reach", () => {
    const m = packedManifest();
    const bf = toBattlefield(m, { v: 3, fences: [], traps: [], posts: [{ ref: "u-rider", cell: inner, stance: "guard" }] }).posts[0]!;
    const R = resolverTunables().unitRadius;
    expect(postReach(m, "u-rider")).toEqual({ aggroReach: (bf.aggroRadius + R) / FIXED_POINT_SCALE, leash: bf.leashDistance / FIXED_POINT_SCALE, attackReach: (bf.attackRange + R) / FIXED_POINT_SCALE });
    expect(postReach(m, "t1")).toBeNull();
    // A post whose aggro reach touches the west ring but whose attack reach does not: guard counts, hold and reserve do not.
    const r = postReach(m, "u-rider")!;
    const west = RING_SEGMENTS.filter((s) => s.edge === "west");
    const westX = west[0]!.cell.x;
    const midY = west[Math.floor(west.length / 2)]!.cell.y;
    const dist = Math.floor(r.attackReach) + 1;
    expect(dist).toBeLessThanOrEqual(r.aggroReach);
    const at = { x: westX + dist, y: midY };
    const reportsFor = (stance: "guard" | "hold" | "reserve") => {
      const f: Formation = setStance(placePost(EMPTY_FORMATION, "u-rider", at, stance), "u-rider", stance);
      return edgeReports(m, f, null).find((x) => x.edge === "west")!.postsWatching;
    };
    expect(reportsFor("guard")).toBe(1);
    expect(reportsFor("hold")).toBe(0);
    expect(reportsFor("reserve")).toBe(0);
  });

  it("D3: the placement picker lists the 28 ring positions for a fence (taken ones refused) and only legal cells for a post", () => {
    const m = packedManifest();
    const f = placeFence(EMPTY_FORMATION, "f3", 5);
    const fence = [...pickerOptions(m, f, "f2").values()].flat();
    expect(fence).toHaveLength(RING_SEGMENTS.length);
    expect(fence.find((o) => o.segment === 5)!.refusal?.code).toBe("duplicate_segment");
    expect(fence.filter((o) => o.refusal === null)).toHaveLength(RING_SEGMENTS.length - 1);
    const post = [...pickerOptions(m, f, "u-rider").values()].flat();
    expect(post.length).toBeGreaterThan(100);
    for (const o of post) expect(isPlaceableCell(o.cell)).toBe(true);
    expect(post.every((o) => o.refusal === null)).toBe(true);
  });
});
