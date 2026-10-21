/**
 * Chunk 50: the round wagon circle as @caravan/circle exposes it (wagons, tunables, closure,
 * "Arrange for me"), checked against packages/resolver/geometry/round-ring.json.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TUNABLES } from "@caravan/content";
import {
  CORE_CENTER_CELL,
  ENTRY_EDGES,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
  RING_SEGMENTS,
  WAGONS,
  cellKey,
  entryBand,
  gapSegment,
  guidedFormation,
  isCoreReachableFrom,
  isGuidePlaceableCell,
  isRingOrAnchorCell,
  isCoreCell,
  isAnyEntryCell,
  sideSegments,
  validateFormation,
  type Cell,
  type EntryEdge,
} from "../src/index.js";
import { ALLOW_ALL, fullPack } from "./fixtures.js";

type XY = readonly [number, number];
const FIXTURE = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../resolver/geometry/round-ring.json"), "utf8")) as {
  wagons: { cells: [XY, XY]; facing: string }[];
};
const tr = ([i, j]: XY): Cell => ({ x: i + CORE_CENTER_CELL.x - 5, y: j + CORE_CENTER_CELL.y - 5 });

describe("WAGONS", () => {
  it("are the fixture's six wagons: cells and facing, in order", () => {
    expect(WAGONS).toHaveLength(6);
    WAGONS.forEach((w, k) => {
      expect(w.cells, `wagon ${k}`).toEqual(FIXTURE.wagons[k]!.cells.map(tr));
      expect(w.facing, `wagon ${k}`).toBe(FIXTURE.wagons[k]!.facing);
    });
  });
});

describe("tunables", () => {
  it("mirror the round ring", () => {
    expect(TUNABLES.PERIMETER_SEGMENTS).toBe(16);
    expect(TUNABLES.RING_ANCHOR_CELLS).toBe(12);
  });
  it("the fence budget is below the ring, so a full ring is unaffordable", () => {
    expect(TUNABLES.FENCE_MATERIAL_BUDGET).toBeLessThan(TUNABLES.PERIMETER_SEGMENTS);
    expect(TUNABLES.FENCE_MATERIAL_BUDGET).toBeLessThan(16);
  });
});

describe("circle isCoreReachableFrom (wagons always blocked)", () => {
  const allFences = new Set(RING_SEGMENTS.map((s) => cellKey(s.cell)));
  const reachable = (blocked: ReadonlySet<number>): boolean => ENTRY_EDGES.some((e) => entryBand(e).some((c) => isCoreReachableFrom(c, blocked)));

  it("all fence cells blocked, wagons not passed in: unreachable from all four bands", () => {
    expect(reachable(allFences)).toBe(false);
  });
  it("every single fence gap makes the core reachable", () => {
    for (const s of RING_SEGMENTS) {
      const blocked = new Set(allFences);
      blocked.delete(cellKey(s.cell));
      expect(reachable(blocked), `gap at segment ${s.index}`).toBe(true);
    }
  });
  it("wagon cells stay blocked even when the caller passes an empty set around them", () => {
    for (const a of RING_ANCHORS) expect(isCoreReachableFrom(a, new Set())).toBe(false);
  });
});

describe("sideSegments and gapSegment", () => {
  it("north is [15, 0, 1], clockwise across the wrap", () => expect(sideSegments("north")).toEqual([15, 0, 1]));
  it("each side lists exactly the segments facing it, in clockwise ring order", () => {
    const want: Record<EntryEdge, number[]> = { north: [15, 0, 1], east: [2, 3, 4], south: [5, 6, 7, 8, 9], west: [10, 11, 12, 13, 14] };
    for (const e of ENTRY_EDGES) {
      expect(sideSegments(e)).toEqual(want[e]);
      expect([...sideSegments(e)].sort((a, b) => a - b)).toEqual(RING_SEGMENTS.filter((s) => s.edge === e).map((s) => s.index));
    }
  });
});

describe("Arrange for me (guidedFormation) on the round ring", () => {
  const m = fullPack();
  for (const edge of ENTRY_EDGES) {
    describe(`main edge ${edge}`, () => {
      const scout = { units: [{ edge }, { edge }], edges: [edge] };
      const f = guidedFormation(m, scout);

      it("is accepted by validateFormation", () => {
        const v = validateFormation(m, f, ALLOW_ALL);
        expect(v.ok, JSON.stringify(v)).toBe(true);
      });
      it("fences only real fence segments and leaves the side's gap segment open", () => {
        expect(f.fences.length).toBeGreaterThan(0);
        for (const p of f.fences) expect(p.segment).toBeGreaterThanOrEqual(0), expect(p.segment).toBeLessThan(PERIMETER_SEGMENTS);
        expect(f.fences.map((p) => p.segment)).not.toContain(gapSegment(edge));
        expect(sideSegments(edge)).toContain(gapSegment(edge));
      });
      it("never places a post or trap on the ring, a wagon, the core or an entry band", () => {
        const cells = [...f.posts.map((p) => p.cell), ...f.traps.map((t) => t.cell)];
        expect(cells.length).toBeGreaterThan(0);
        for (const c of cells) {
          expect(isRingOrAnchorCell(c), `ring/wagon ${c.x},${c.y}`).toBe(false);
          expect(RING_ANCHORS.some((a) => a.x === c.x && a.y === c.y)).toBe(false);
          expect(isCoreCell(c)).toBe(false);
          expect(isAnyEntryCell(c)).toBe(false);
          expect(isGuidePlaceableCell(c)).toBe(true);
        }
      });
    });
  }
});
