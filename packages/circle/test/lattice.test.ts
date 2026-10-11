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
  PERIMETER_SEGMENTS,
  RING_SEGMENTS,
  cellCenter,
  cellDistSq,
  cellKey,
  cellOf,
  distSq,
  entryBand,
  fixedSq,
  isAnyEntryCell,
  isCell,
  isCoreCell,
  isCoreReachableFrom,
  isEntryCell,
  isInBounds,
  isRingCell,
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
  it("has PERIMETER_SEGMENTS positions forming one closed loop around the core", () => {
    expect(PERIMETER_SEGMENTS).toBe(32);
    expect(RING_SEGMENTS).toHaveLength(32);
    RING_SEGMENTS.forEach((s, i) => {
      expect(s.index).toBe(i);
      expect(isInBounds(s.cell)).toBe(true);
      expect(ringIndexAt(s.cell)).toBe(i);
      expect(ringSegment(i)).toBe(s);
      const next = RING_SEGMENTS[(i + 1) % 32]!;
      expect(cellDistSq(s.cell, next.cell)).toBe(1); // consecutive segments touch
    });
    const keys = new Set(RING_SEGMENTS.map((s) => cellKey(s.cell)));
    expect(keys.size).toBe(32);
    for (const edge of ENTRY_EDGES) expect(RING_SEGMENTS.filter((s) => s.edge === edge)).toHaveLength(8);
    expect(RING_SEGMENTS[0]!.cell).toEqual({ x: 11, y: 11 });
    expect(RING_SEGMENTS[8]!.cell).toEqual({ x: 19, y: 11 });
    expect(RING_SEGMENTS[16]!.cell).toEqual({ x: 19, y: 19 });
    expect(RING_SEGMENTS[24]!.cell).toEqual({ x: 11, y: 19 });
    expect(() => ringSegment(32)).toThrow();
  });

  it("the material budget is below a full ring, so a gap is forced", () => {
    expect(TUNABLES.FENCE_MATERIAL_BUDGET).toBeLessThan(PERIMETER_SEGMENTS);
    expect(TUNABLES.FENCE_MATERIAL_BUDGET).toBe(24);
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
    expect(blocked.size).toBe(24);
    for (const edge of ENTRY_EDGES) expect(isCoreReachableFrom(entryBand(edge)[0]!, blocked)).toBe(true);
  });

  it("a hypothetical full ring (unaffordable) would seal the core — which is why the budget is below it", () => {
    const sealed = new Set(RING_SEGMENTS.map((s) => cellKey(s.cell)));
    const start: Cell = { x: 0, y: 0 };
    expect(isCoreReachableFrom(start, sealed)).toBe(false);
  });
});
