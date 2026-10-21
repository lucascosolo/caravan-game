/**
 * The guide's posts and rest-of-fence on the round ring: posts spread over the threatened edges
 * (unit i goes to edge i % n), the rest of the fence closes the sides nearest the scouted raiders.
 */
import { describe, expect, it } from "vitest";
import {
  CORE_CENTER_CELL,
  DEFAULT_DEFENSIVE_STANCE,
  FORMATION_VERSION,
  EMPTY_FORMATION,
  GRID_HEIGHT,
  GRID_WIDTH,
  RING_SEGMENTS,
  applyMainFence,
  applyOpenGap,
  applyPosts,
  applyRestOfFence,
  arrangeStatus,
  gapSegment,
  guidedFormation,
  inwardFromGap,
  mainEdge,
  nearestLegalCell,
  postTarget,
  ringSegment,
  type Cell,
  type EntryEdge,
  type Formation,
} from "../src/index.js";
import { fullPack } from "./fixtures.js";

const scoutOf = (counts: Partial<Record<EntryEdge, number>>, edges: EntryEdge[] = []) => ({
  units: (Object.entries(counts) as [EntryEdge, number][]).flatMap(([edge, n]) => Array.from({ length: n }, () => ({ edge }))),
  edges,
});
const edgeDist = (c: Cell, e: EntryEdge): number => (e === "north" ? c.y : e === "south" ? GRID_HEIGHT - 1 - c.y : e === "west" ? c.x : GRID_WIDTH - 1 - c.x);

const toward = (e: EntryEdge): Cell => ({ x: CORE_CENTER_CELL.x + (e === "east" ? 2 : e === "west" ? -2 : 0), y: CORE_CENTER_CELL.y + (e === "south" ? 2 : e === "north" ? -2 : 0) });

describe("postTarget", () => {
  const ne = scoutOf({ north: 2, east: 1 }); // threatened: north (main), east
  it("unit 0 targets two cells inward from the main gap", () => {
    expect(postTarget(ne, 0)).toEqual(inwardFromGap("north", 2));
  });
  it("another threatened edge targets the core centre moved two cells toward it", () => {
    expect(postTarget(ne, 1)).toEqual(toward("east"));
    expect(postTarget(scoutOf({ south: 1, west: 1 }), 1)).toEqual(toward("west")); // tie: south before west
    expect(postTarget(scoutOf({ west: 1, south: 1, north: 1 }), 1)).toEqual(toward("south")); // tie 1/1/1: north main, then south
    expect(postTarget(scoutOf({ west: 2, north: 1 }), 1)).toEqual(toward("north"));
  });
  it("wraps around the threatened edges: i % n", () => {
    expect(postTarget(ne, 2)).toEqual(postTarget(ne, 0));
    expect(postTarget(ne, 3)).toEqual(postTarget(ne, 1));
  });
  it("threatened edges are only those with raiders, most first", () => {
    const s = scoutOf({ east: 3, west: 1 });
    expect(postTarget(s, 0)).toEqual(inwardFromGap("east", 2));
    expect(postTarget(s, 1)).toEqual(toward("west"));
    expect(postTarget(s, 2)).toEqual(inwardFromGap("east", 2));
  });
  it("with no scouted raider every unit targets the main edge", () => {
    const s = scoutOf({}, ["south"]);
    expect(mainEdge(s)).toBe("south");
    for (const i of [0, 1, 5]) expect(postTarget(s, i)).toEqual(inwardFromGap("south", 2));
  });
});

describe("applyPosts spreads units over the threatened edges", () => {
  const m = fullPack();
  const four = scoutOf({ north: 1, east: 1, south: 1, west: 1 });

  it("a 4-edge scout with 8 units: unit i sits on the legal cell nearest postTarget(i), the trap cell kept free", () => {
    const f = applyPosts(m, EMPTY_FORMATION, four);
    expect(f.posts.map((p) => p.ref)).toEqual(m.units.map((u) => u.ref));
    let prev: Formation = EMPTY_FORMATION;
    const keep = inwardFromGap(mainEdge(four), 1);
    m.units.forEach((u, i) => {
      const want = nearestLegalCell(m, prev, u.ref, postTarget(four, i), [keep]);
      const got = f.posts.find((p) => p.ref === u.ref)!;
      expect(got.cell, `unit ${i}`).toEqual(want);
      prev = { ...prev, posts: [...prev.posts, got] };
    });
    expect(f.posts.some((p) => p.cell.x === keep.x && p.cell.y === keep.y)).toBe(false);
  });

  it("one post lies on each edge's side of the core (north, east, south, west)", () => {
    const f = applyPosts(m, EMPTY_FORMATION, four);
    const at = (i: number): Cell => f.posts[i]!.cell;
    expect(at(0).y).toBeLessThan(CORE_CENTER_CELL.y); // north: main gap side
    expect(at(1).x).toBeGreaterThan(CORE_CENTER_CELL.x); // east
    expect(at(2).y).toBeGreaterThan(CORE_CENTER_CELL.y); // south
    expect(at(3).x).toBeLessThan(CORE_CENTER_CELL.x); // west
    expect(at(0)).toEqual(nearestLegalCell(m, EMPTY_FORMATION, m.units[0]!.ref, inwardFromGap("north", 2), [inwardFromGap("north", 1)]));
  });

  it("units already posted are left alone", () => {
    const first = applyPosts(m, EMPTY_FORMATION, four);
    expect(applyPosts(m, first, four)).toEqual(first);
  });
});

describe("arrangeStatus.nextPost", () => {
  const m = fullPack();
  const ne = scoutOf({ north: 2, east: 1 });
  const posted = (ref: string, cell: Cell): Formation => ({ v: FORMATION_VERSION, fences: [], traps: [], posts: [{ ref, cell, stance: DEFAULT_DEFENSIVE_STANCE }] });

  it("nothing posted: the first unit's post is on the main edge's target", () => {
    const next = arrangeStatus(m, EMPTY_FORMATION, ne).nextPost!;
    expect(next.ref).toBe(m.units[0]!.ref);
    expect(next.cell).toEqual(nearestLegalCell(m, EMPTY_FORMATION, next.ref, postTarget(ne, 0), [inwardFromGap("north", 1)]));
  });
  it("after one unit is posted, the next one aims for the second threatened edge", () => {
    const f = posted(m.units[0]!.ref, { x: 17, y: 13 });
    const next = arrangeStatus(m, f, ne).nextPost!;
    expect(next.ref).toBe(m.units[1]!.ref);
    expect(next.cell).toEqual(nearestLegalCell(m, f, next.ref, postTarget(ne, 1), [inwardFromGap("north", 1)]));
    expect(next.cell.x).toBeGreaterThan(CORE_CENTER_CELL.x);
  });
});

describe("applyRestOfFence closes the sides nearest the scouted raiders", () => {
  const m = fullPack();
  const unfencedNonGap = (f: Formation, gap: number) => RING_SEGMENTS.filter((s) => s.index !== gap && !f.fences.some((p) => p.segment === s.index));

  it("a 1-edge north scout: the unfenced positions all lie on the side farthest from north", () => {
    const f = guidedFormation(m, scoutOf({ north: 3 }));
    const open = unfencedNonGap(f, gapSegment("north"));
    expect(open.length).toBeGreaterThan(0);
    const fenced = f.fences.map((p) => edgeDist(ringSegment(p.segment).cell, "north"));
    const minOpen = Math.min(...open.map((s) => edgeDist(s.cell, "north")));
    expect(Math.max(...fenced)).toBeLessThanOrEqual(minOpen);
    for (const s of open) expect(s.cell.y).toBeGreaterThan(CORE_CENTER_CELL.y);
  });

  it("a west scout leaves the east side open instead", () => {
    const f = guidedFormation(m, scoutOf({ west: 2 }));
    const open = unfencedNonGap(f, gapSegment("west"));
    expect(open.length).toBeGreaterThan(0);
    for (const s of open) expect(s.cell.x).toBeGreaterThan(CORE_CENTER_CELL.x);
  });

  it("distance is to the NEAREST scouted edge: with north and south raiders the flanks stay open", () => {
    const f = guidedFormation(m, scoutOf({ north: 2, south: 1 }));
    const d = (c: Cell) => Math.min(edgeDist(c, "north"), edgeDist(c, "south"));
    const open = unfencedNonGap(f, gapSegment("north"));
    const minOpen = Math.min(...open.map((s) => d(s.cell)));
    expect(Math.max(...f.fences.map((p) => d(ringSegment(p.segment).cell)))).toBeLessThanOrEqual(minOpen);
  });

  it("spends the whole wagon, skips already fenced positions and never fences the gap", () => {
    const sc = scoutOf({ north: 1 });
    const start = applyOpenGap(applyMainFence(m, EMPTY_FORMATION, sc), sc);
    const f = applyRestOfFence(m, start, sc);
    expect(f.fences).toHaveLength(m.fences.length);
    for (const p of start.fences) expect(f.fences).toContainEqual(p);
    expect(new Set(f.fences.map((p) => p.segment)).size).toBe(f.fences.length);
    expect(f.fences.map((p) => p.segment)).not.toContain(gapSegment("north"));
    expect(applyRestOfFence(m, f, sc)).toEqual(f);
  });
});
