import { FIXED_POINT_SCALE, TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import {
  CORE_CELLS,
  CORE_CENTER,
  CORE_CENTER_CELL,
  ENTRY_EDGES,
  GRID_HEIGHT,
  GRID_WIDTH,
  HALF_CELL,
  PATH_CONNECTIVITY,
  INTERIOR_POST_CELLS,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
  RING_ANCHOR_CELLS,
  RING_ORDER,
  RING_SEGMENTS,
  cellCenter,
  cellDistSq,
  cellKey,
  cellOf,
  distSq,
  entryBand,
  fixedSq,
  isAnchorCell,
  isAnyEntryCell,
  isCell,
  isCoreCell,
  isCoreReachableFrom,
  isEntryCell,
  isInBounds,
  isInsideRing,
  isRingCell,
  isRingOrAnchorCell,
  neighbours4,
  ringIndexAt,
  ringSegment,
  validateFormation,
  type Cell,
} from "../src/index.js";
import { ALLOW_ALL, arrange, fullPack } from "./fixtures.js";

describe("placement lattice", () => {
  it("is 32 × 32 integer cells and nothing else", () => {
    expect([GRID_WIDTH, GRID_HEIGHT]).toEqual([32, 32]);
    expect(isCell({ x: 0, y: 0 })).toBe(true);
    expect(isCell({ x: 31, y: 31 })).toBe(true);
    expect(isCell({ x: 32, y: 0 })).toBe(false);
    expect(isCell({ x: -1, y: 0 })).toBe(false);
    expect(isCell({ x: 1.5, y: 0 })).toBe(false);
    expect(isCell({ x: 1, y: 1, z: 0 })).toBe(false);
    expect(isCell({ x: 1, y: 1, elevation: 2 })).toBe(false);
    expect(isInBounds({ x: 3, y: 0.5 })).toBe(false);
  });

  it("converts a cell to its continuous centre once, as coordinate × scale + half a cell", () => {
    expect(HALF_CELL).toBe(512);
    expect(cellCenter({ x: 0, y: 0 })).toEqual({ x: 512, y: 512 });
    expect(cellCenter({ x: 3, y: 7 })).toEqual({ x: 3 * FIXED_POINT_SCALE + 512, y: 7 * FIXED_POINT_SCALE + 512 });
    for (let y = 0; y < GRID_HEIGHT; y++) for (let x = 0; x < GRID_WIDTH; x++) expect(cellOf(cellCenter({ x, y }))).toEqual({ x, y });
  });

  it("uses one Euclidean metric, compared squared, in integers", () => {
    const a = cellCenter({ x: 1, y: 1 });
    const b = cellCenter({ x: 4, y: 5 });
    expect(distSq(a, b)).toBe((3 * 1024) ** 2 + (4 * 1024) ** 2);
    expect(distSq(a, b)).toBe(fixedSq((5 * 1024) as never));
    expect(Number.isSafeInteger(distSq(cellCenter({ x: 0, y: 0 }), cellCenter({ x: 31, y: 31 })))).toBe(true);
    expect(cellDistSq({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(8);
  });
});

describe("caravan core", () => {
  it("is a fixed 3 × 3 block at the lattice centre, not player-placed", () => {
    expect(TUNABLES.CORE_SIZE).toBe(3);
    expect(CORE_CELLS).toHaveLength(9);
    expect(CORE_CENTER_CELL).toEqual({ x: 15, y: 15 });
    expect(CORE_CENTER).toEqual(cellCenter(CORE_CENTER_CELL));
    for (const c of CORE_CELLS) {
      expect(Math.abs(c.x - 15)).toBeLessThanOrEqual(1);
      expect(Math.abs(c.y - 15)).toBeLessThanOrEqual(1);
      expect(isCoreCell(c)).toBe(true);
      expect(isRingCell(c)).toBe(false);
      expect(isAnyEntryCell(c)).toBe(false);
    }
    expect(isCoreCell({ x: 13, y: 15 })).toBe(false);
  });
});

describe("fence ring", () => {
  it("has PERIMETER_SEGMENTS positions which, with the twelve wagon cells, form one closed loop around the core", () => {
    expect(PERIMETER_SEGMENTS).toBe(16);
    expect(TUNABLES.PERIMETER_SEGMENTS).toBe(16);
    expect(RING_SEGMENTS).toHaveLength(16);
    RING_SEGMENTS.forEach((s, i) => {
      expect(s.index).toBe(i);
      expect(isInBounds(s.cell)).toBe(true);
      expect(ringIndexAt(s.cell)).toBe(i);
      expect(ringSegment(i)).toBe(s);
      expect(isAnchorCell(s.cell)).toBe(false);
    });
    // Consecutive ring cells (fence positions and wagon cells interleaved, in RING_ORDER) touch, diagonally at most.
    RING_ORDER.forEach((c, i) => expect([1, 2]).toContain(cellDistSq(c, RING_ORDER[(i + 1) % RING_ORDER.length]!)));
    expect(RING_ORDER).toHaveLength(28);
    expect(new Set(RING_SEGMENTS.map((s) => cellKey(s.cell))).size).toBe(16);
    const keys = new Set([...RING_SEGMENTS.map((s) => cellKey(s.cell)), ...RING_ANCHORS.map(cellKey)]);
    expect(keys.size).toBe(28);
    for (const a of RING_ANCHORS) expect(isAnchorCell(a) && !isRingCell(a) && ringIndexAt(a) === null).toBe(true);
    for (const edge of ENTRY_EDGES) expect(RING_SEGMENTS.filter((s) => s.edge === edge).length).toBeGreaterThan(0);
    expect(RING_SEGMENTS.map((s) => s.edge)).toEqual(["north", "north", "east", "east", "east", "south", "south", "south", "south", "south", "west", "west", "west", "west", "west", "north"]);
    expect(RING_SEGMENTS[0]!.cell).toEqual({ x: 17, y: 11 });
    expect(RING_SEGMENTS[4]!.cell).toEqual({ x: 20, y: 16 });
    expect(RING_SEGMENTS[7]!.cell).toEqual({ x: 16, y: 20 });
    expect(RING_SEGMENTS[12]!.cell).toEqual({ x: 10, y: 16 });
    expect(() => ringSegment(16)).toThrow();
  });

  it("QA D2: the twelve wagon cells (six two-cell wagons) are fixed — not fence positions, not placeable, always blocked", () => {
    expect(TUNABLES.RING_ANCHOR_CELLS).toBe(12);
    expect(RING_ANCHOR_CELLS).toBe(12);
    expect(RING_ANCHORS).toEqual([
      { x: 15, y: 10 }, { x: 16, y: 10 },
      { x: 20, y: 14 }, { x: 20, y: 15 },
      { x: 19, y: 17 }, { x: 19, y: 18 },
      { x: 15, y: 20 }, { x: 14, y: 20 },
      { x: 10, y: 15 }, { x: 10, y: 14 },
      { x: 12, y: 11 }, { x: 13, y: 11 },
    ]);
    for (const a of RING_ANCHORS) {
      expect(isAnchorCell(a)).toBe(true);
      expect(isRingCell(a)).toBe(false);
      expect(ringIndexAt(a)).toBeNull();
      expect(isRingOrAnchorCell(a)).toBe(true);
      expect(isCoreCell(a) || isAnyEntryCell(a)).toBe(false);
      // Even on an otherwise empty field, an anchor cannot be stepped on or started from.
      expect(isCoreReachableFrom(a, new Set())).toBe(false);
    }
    expect(RING_ANCHOR_CELLS + PERIMETER_SEGMENTS).toBe(RING_ORDER.length);
    // The ring is round: it strictly encloses the core and the interior post cells, and is not the old square.
    for (const c of RING_ORDER) expect(isInsideRing(c)).toBe(false);
    expect(CORE_CELLS.every(isInsideRing)).toBe(true);
    expect(INTERIOR_POST_CELLS.every((c) => isInsideRing(c) && !isCoreCell(c) && !isRingOrAnchorCell(c) && !isAnyEntryCell(c))).toBe(true);
    for (const c of [{ x: 11, y: 11 }, { x: 19, y: 11 }, { x: 19, y: 19 }, { x: 11, y: 19 }]) expect(isRingOrAnchorCell(c)).toBe(false);
  });

  it("QA D2: pathing is 4-connected with no corner cutting", () => {
    expect(TUNABLES.PATH_CONNECTIVITY).toBe(4);
    expect(PATH_CONNECTIVITY).toBe(4);
    expect(neighbours4({ x: 5, y: 5 })).toEqual([
      { x: 5, y: 4 },
      { x: 4, y: 5 },
      { x: 6, y: 5 },
      { x: 5, y: 6 },
    ]);
    // Two diagonally touching blocked cells seal a corner: (3,3) blocked, (4,4) blocked — a
    // walker at (4,3) cannot slip to (3,4) through the shared corner. Box (4,3) in fully.
    const blocked = new Set([{ x: 3, y: 3 }, { x: 4, y: 4 }, { x: 5, y: 3 }, { x: 4, y: 2 }].map(cellKey));
    expect(isCoreReachableFrom({ x: 4, y: 3 }, blocked)).toBe(false);
    blocked.delete(cellKey({ x: 5, y: 3 }));
    expect(isCoreReachableFrom({ x: 4, y: 3 }, blocked)).toBe(true);
  });

  it("QA D2: all 16 segments fenced seals the core; any single gap opens it from every edge", () => {
    const allFenced = new Set(RING_SEGMENTS.map((s) => cellKey(s.cell)));
    for (const edge of ENTRY_EDGES) for (const start of entryBand(edge)) expect(isCoreReachableFrom(start, allFenced)).toBe(false);
    for (const gap of RING_SEGMENTS) {
      const blocked = new Set(allFenced);
      blocked.delete(cellKey(gap.cell));
      for (const edge of ENTRY_EDGES) expect(isCoreReachableFrom(entryBand(edge)[0]!, blocked), `gap at segment ${gap.index}`).toBe(true);
    }
  });

  it("the material budget is below a full ring, so a gap is forced (11 of 16: 5 gaps)", () => {
    expect(TUNABLES.FENCE_MATERIAL_BUDGET).toBeLessThan(PERIMETER_SEGMENTS);
    expect(TUNABLES.FENCE_MATERIAL_BUDGET).toBe(11);
    expect(PERIMETER_SEGMENTS - TUNABLES.FENCE_MATERIAL_BUDGET).toBe(5);
  });
});

describe("entry edges", () => {
  it("exist on all four sides, each a band of the outermost cells", () => {
    expect(ENTRY_EDGES).toEqual(["north", "east", "south", "west"]);
    expect(TUNABLES.ENTRY_BAND_DEPTH).toBe(2);
    for (const edge of ENTRY_EDGES) expect(entryBand(edge)).toHaveLength(2 * 32);
    expect(isEntryCell({ x: 15, y: 0 }, "north")).toBe(true);
    expect(isEntryCell({ x: 15, y: 1 }, "north")).toBe(true);
    expect(isEntryCell({ x: 15, y: 2 }, "north")).toBe(false);
    expect(isEntryCell({ x: 31, y: 15 }, "east")).toBe(true);
    expect(isEntryCell({ x: 15, y: 31 }, "south")).toBe(true);
    expect(isEntryCell({ x: 0, y: 15 }, "west")).toBe(true);
    expect(isEntryCell({ x: 0, y: 15 }, "east")).toBe(false);
    expect(isEntryCell({ x: 0, y: 0 }, "north") && isEntryCell({ x: 0, y: 0 }, "west")).toBe(true);
  });

  it("an attacking party can be split across edges: every pair of edges has disjoint band cells to start from", () => {
    for (const a of ENTRY_EDGES) {
      for (const b of ENTRY_EDGES) {
        if (a === b) continue;
        const onlyA = entryBand(a).filter((c) => !isEntryCell(c, b));
        expect(onlyA.length).toBeGreaterThan(0);
      }
    }
  });

  it("the core is reachable from every edge across an empty field and across a legal gapped ring", () => {
    const empty = new Set<number>();
    for (const edge of ENTRY_EDGES) for (const start of entryBand(edge)) expect(isCoreReachableFrom(start, empty)).toBe(true);

    const m = fullPack();
    const f = validateFormation(m, arrange(m), ALLOW_ALL);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    const blocked = new Set(f.value.fences.map((p) => cellKey(ringSegment(p.segment).cell)));
    expect(blocked.size).toBe(TUNABLES.FENCE_MATERIAL_BUDGET);
    for (const edge of ENTRY_EDGES) expect(isCoreReachableFrom(entryBand(edge)[0]!, blocked)).toBe(true);
  });

  it("a hypothetical full ring (unaffordable) plus the wagon cells would seal the core — which is why the budget is below it", () => {
    const sealed = new Set(RING_SEGMENTS.map((s) => cellKey(s.cell)));
    const start: Cell = { x: 0, y: 0 };
    expect(isCoreReachableFrom(start, sealed)).toBe(false);
    // The twelve wagon cells need not be passed: they are blocked by the lattice itself.
    expect(sealed.size).toBe(16);
  });
});
