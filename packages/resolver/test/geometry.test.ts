/**
 * The battlefield geometry the resolver owns: the lattice, the one lattice→continuous
 * conversion, the 16-segment round ring with its six permanent wagons, and reachability.
 */
import { describe, expect, it } from "vitest";
import {
  CORE_CELLS,
  CORE_CENTER,
  CORE_CENTER_CELL,
  ENTRY_EDGES,
  FIXED_POINT_SCALE,
  GRID_HEIGHT,
  GRID_WIDTH,
  HALF_CELL,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
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
  isRingCell,
  ringIndexAt,
  ringSegment,
  type Cell,
} from "../src/index.js";

const blockedBy = (cells: readonly Cell[]) => {
  const keys = new Set(cells.map(cellKey));
  return (k: number) => keys.has(k);
};

describe("placement lattice", () => {
  it("is 32 × 32 integer cells and nothing else", () => {
    expect([GRID_WIDTH, GRID_HEIGHT]).toEqual([32, 32]);
    expect(isCell({ x: 0, y: 0 })).toBe(true);
    expect(isCell({ x: 31, y: 31 })).toBe(true);
    expect(isCell({ x: 32, y: 0 })).toBe(false);
    expect(isCell({ x: 1.5, y: 0 })).toBe(false);
    expect(isCell({ x: 1, y: 1, elevation: 2 })).toBe(false);
    expect(isInBounds({ x: 3, y: 0.5 })).toBe(false);
  });

  it("converts a cell to its continuous centre once, as coordinate × scale + half a cell, and back", () => {
    expect(FIXED_POINT_SCALE).toBe(1024);
    expect(HALF_CELL).toBe(512);
    expect(cellCenter({ x: 0, y: 0 })).toEqual({ x: 512, y: 512 });
    expect(cellCenter({ x: 3, y: 7 })).toEqual({ x: 3 * 1024 + 512, y: 7 * 1024 + 512 });
    for (let y = 0; y < GRID_HEIGHT; y++) for (let x = 0; x < GRID_WIDTH; x++) expect(cellOf(cellCenter({ x, y }))).toEqual({ x, y });
    // Any point inside a cell maps back to it, including its corner and its last unit.
    expect(cellOf({ x: 3 * 1024 as never, y: 7 * 1024 as never })).toEqual({ x: 3, y: 7 });
    expect(cellOf({ x: (4 * 1024 - 1) as never, y: (8 * 1024 - 1) as never })).toEqual({ x: 3, y: 7 });
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

describe("core, ring and anchors", () => {
  it("the core is a fixed 3 × 3 block at the centre", () => {
    expect(CORE_CELLS).toHaveLength(9);
    expect(CORE_CENTER_CELL).toEqual({ x: 15, y: 15 });
    expect(CORE_CENTER).toEqual(cellCenter(CORE_CENTER_CELL));
    for (const c of CORE_CELLS) expect(isCoreCell(c) && !isRingCell(c) && !isAnyEntryCell(c) && !isAnchorCell(c)).toBe(true);
    expect(isCoreCell({ x: 13, y: 15 })).toBe(false);
  });

  it("the six wagons are permanent anchors, not segments", () => {
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
    }
  });

  it("has 16 buyable segments forming, with the wagon cells, one closed loop around the core", () => {
    expect(PERIMETER_SEGMENTS).toBe(16);
    expect(RING_SEGMENTS).toHaveLength(16);
    RING_SEGMENTS.forEach((s, i) => {
      expect(s.index).toBe(i);
      expect(isInBounds(s.cell)).toBe(true);
      expect(ringIndexAt(s.cell)).toBe(i);
      expect(ringSegment(i)).toBe(s);
      const reach = Math.max(Math.abs(s.cell.x - 15), Math.abs(s.cell.y - 15));
      expect(reach === 4 || reach === 5).toBe(true);
    });
    const loop = [...RING_SEGMENTS.map((s) => s.cell), ...RING_ANCHORS];
    expect(new Set(loop.map(cellKey)).size).toBe(28);
    // A thin closed curve: every cell has at least two ring neighbours one step away, axis or diagonal.
    for (const a of loop) expect(loop.filter((b) => cellDistSq(a, b) === 1 || cellDistSq(a, b) === 2).length).toBeGreaterThanOrEqual(2);
    const perEdge = Object.fromEntries(ENTRY_EDGES.map((edge) => [edge, RING_SEGMENTS.filter((s) => s.edge === edge).length]));
    expect(perEdge).toEqual({ north: 3, east: 3, south: 5, west: 5 });
    expect(RING_SEGMENTS[0]!.cell).toEqual({ x: 17, y: 11 });
    expect(RING_SEGMENTS[4]!.cell).toEqual({ x: 20, y: 16 });
    expect(RING_SEGMENTS[7]!.cell).toEqual({ x: 16, y: 20 });
    expect(RING_SEGMENTS[10]!.cell).toEqual({ x: 11, y: 18 });
    expect(RING_SEGMENTS[15]!.cell).toEqual({ x: 14, y: 10 });
    expect(() => ringSegment(16)).toThrow();
  });

  it("entry bands are the outermost two cells of every edge", () => {
    for (const edge of ENTRY_EDGES) expect(entryBand(edge)).toHaveLength(64);
    expect(isEntryCell({ x: 15, y: 1 }, "north")).toBe(true);
    expect(isEntryCell({ x: 15, y: 2 }, "north")).toBe(false);
    expect(isEntryCell({ x: 0, y: 15 }, "west") && isEntryCell({ x: 31, y: 15 }, "east") && isEntryCell({ x: 15, y: 31 }, "south")).toBe(true);
  });

  it("a fully fenced 16-segment ring plus the wagons seals the core; one gap opens it", () => {
    const sealed = blockedBy([...RING_SEGMENTS.map((s) => s.cell), ...RING_ANCHORS]);
    for (const edge of ENTRY_EDGES) for (const start of entryBand(edge)) expect(isCoreReachableFrom(start, sealed)).toBe(false);
    const oneGap = blockedBy([...RING_SEGMENTS.filter((s) => s.index !== 9).map((s) => s.cell), ...RING_ANCHORS]);
    for (const edge of ENTRY_EDGES) expect(isCoreReachableFrom(entryBand(edge)[0]!, oneGap)).toBe(true);
    // The anchors alone (no fences) block nothing that matters.
    expect(isCoreReachableFrom({ x: 0, y: 0 }, blockedBy(RING_ANCHORS))).toBe(true);
    // 4-connected: a diagonal gap between two blocked cells is NOT a passage. Segment 0 (17,11) is open, but its only
    // outside neighbour (17,10) is blocked, so the open outside cell (18,10) touches it only diagonally.
    const diagonalOnly = blockedBy([...RING_SEGMENTS.filter((s) => s.index !== 0).map((s) => s.cell), ...RING_ANCHORS, { x: 17, y: 10 }]);
    expect(isCoreReachableFrom({ x: 0, y: 0 }, diagonalOnly)).toBe(false);
  });
});
