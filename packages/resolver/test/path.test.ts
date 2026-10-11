/**
 * Lattice A*, line of sight and string pulling: 4-connectivity, the documented tie-break
 * (equal f → lower row, then lower column), breach edges priced by cost, and the integer
 * LOS test's corner conservatism.
 */
import { describe, expect, it } from "vitest";
import { CELL_ANCHOR, COST_INFINITE, STEP_COST, cellCenter, cellKey, emptyGrid, findPath, losClear, smoothPath, type Cell, type PathGrid } from "../src/index.js";

function gridWith(blocked: readonly Cell[], fences: readonly { cell: Cell; index: number }[] = []): PathGrid {
  const g = emptyGrid();
  for (const c of blocked) g[cellKey(c)] = CELL_ANCHOR;
  for (const f of fences) g[cellKey(f.cell)] = f.index;
  return g;
}
const noBreach = () => COST_INFINITE;
const cells = (steps: readonly { cell: Cell }[]) => steps.map((s) => `${s.cell.x},${s.cell.y}`);

describe("findPath (4-connected A*)", () => {
  it("returns the steps after the start, ending at the goal, with Manhattan length on an open field", () => {
    const path = findPath(emptyGrid(), { x: 2, y: 3 }, { x: 6, y: 5 }, noBreach)!;
    expect(path).toHaveLength(6);
    expect(path[path.length - 1]!.cell).toEqual({ x: 6, y: 5 });
    for (let i = 0; i < path.length; i++) {
      const prev = i === 0 ? { x: 2, y: 3 } : path[i - 1]!.cell;
      const d = Math.abs(path[i]!.cell.x - prev.x) + Math.abs(path[i]!.cell.y - prev.y);
      expect(d, "every step is orthogonal: no diagonal moves").toBe(1);
    }
    expect(findPath(emptyGrid(), { x: 4, y: 4 }, { x: 4, y: 4 }, noBreach)).toEqual([]);
  });

  it("never cuts a corner: two diagonal blockers are a wall", () => {
    // (5,5) and (6,6) blocked; from (6,5) to (5,6) an 8-connected path would slip between them.
    const g = gridWith([{ x: 5, y: 5 }, { x: 6, y: 6 }]);
    const path = findPath(g, { x: 6, y: 5 }, { x: 5, y: 6 }, noBreach)!;
    expect(path.length).toBeGreaterThanOrEqual(4);
    for (const s of path) expect([cellKey({ x: 5, y: 5 }), cellKey({ x: 6, y: 6 })]).not.toContain(cellKey(s.cell));
  });

  it("PATH_TIE_BREAK: of two equal-cost routes round a wall, the lower-COLUMN side wins (vertical symmetry)", () => {
    // Horizontal wall y=7, x=3..7; start (5,5), goal (5,9): going round either end costs the same.
    const wall: Cell[] = [];
    for (let x = 3; x <= 7; x++) wall.push({ x, y: 7 });
    const path = findPath(gridWith(wall), { x: 5, y: 5 }, { x: 5, y: 9 }, noBreach)!;
    const xs = path.map((s) => s.cell.x);
    expect(Math.min(...xs)).toBe(2);
    expect(Math.max(...xs)).toBeLessThanOrEqual(5);
  });

  it("PATH_TIE_BREAK: of two equal-cost routes round a wall, the lower-ROW side wins (horizontal symmetry)", () => {
    // Vertical wall x=7, y=3..7; start (5,5), goal (9,5).
    const wall: Cell[] = [];
    for (let y = 3; y <= 7; y++) wall.push({ x: 7, y });
    const path = findPath(gridWith(wall), { x: 5, y: 5 }, { x: 9, y: 5 }, noBreach)!;
    const ys = path.map((s) => s.cell.y);
    expect(Math.min(...ys)).toBe(2);
    expect(Math.max(...ys)).toBeLessThanOrEqual(5);
  });

  it("the tie-break is a stable total order: the same query always yields the same steps", () => {
    const wall: Cell[] = [];
    for (let x = 3; x <= 7; x++) wall.push({ x, y: 7 });
    const a = cells(findPath(gridWith(wall), { x: 5, y: 5 }, { x: 5, y: 9 }, noBreach)!);
    for (let i = 0; i < 20; i++) expect(cells(findPath(gridWith(wall), { x: 5, y: 5 }, { x: 5, y: 9 }, noBreach)!)).toEqual(a);
  });

  it("FENCE_BLOCKS_PATHING: breaking through is a priced edge — chosen when cheaper than the detour, avoided when dearer", () => {
    // A wall of fences across the whole row y=10 except one gap at x=0; start (15,8), goal (15,12).
    const fences = [];
    for (let x = 1; x < 32; x++) fences.push({ cell: { x, y: 10 }, index: x });
    const g = gridWith([], fences);
    // Detour via the gap at x=0: 15 + 4 + 15 = 34 steps vs straight through: 4 steps + breach cost.
    const cheap = findPath(g, { x: 15, y: 8 }, { x: 15, y: 12 }, () => 10 * STEP_COST)!;
    expect(cheap).toHaveLength(4);
    expect(cheap.find((s) => s.breach >= 0)!.cell).toEqual({ x: 15, y: 10 });
    expect(cheap.find((s) => s.breach >= 0)!.breach).toBe(15);
    const dear = findPath(g, { x: 15, y: 8 }, { x: 15, y: 12 }, () => 40 * STEP_COST)!;
    expect(dear.every((s) => s.breach < 0)).toBe(true);
    expect(dear).toHaveLength(34);
    expect(dear.some((s) => s.cell.x === 0 && s.cell.y === 10)).toBe(true);
    // Exactly equal cost (30 steps of detour saved vs 30 steps of breach): the lower-row tie-break
    // expands the direct route's cells first, so the breach is taken. Pinned so a change is visible.
    const equal = findPath(g, { x: 15, y: 8 }, { x: 15, y: 12 }, () => 30 * STEP_COST)!;
    expect(equal).toHaveLength(4);
  });

  it("an anchor is never breachable and a goal on an anchor has no path", () => {
    const g = gridWith([{ x: 10, y: 10 }]);
    expect(findPath(g, { x: 9, y: 10 }, { x: 10, y: 10 }, () => 0)).toBeNull();
    const around = findPath(g, { x: 9, y: 10 }, { x: 11, y: 10 }, () => 0)!;
    expect(around).toHaveLength(4);
  });

  it("a fence with infinite breach cost is a wall; a sealed goal is unreachable", () => {
    const box = [{ x: 9, y: 10 }, { x: 11, y: 10 }, { x: 10, y: 9 }, { x: 10, y: 11 }].map((cell, i) => ({ cell, index: i }));
    expect(findPath(gridWith([], box), { x: 0, y: 0 }, { x: 10, y: 10 }, noBreach)).toBeNull();
    expect(findPath(gridWith([], box), { x: 0, y: 0 }, { x: 10, y: 10 }, () => 0)).not.toBeNull();
  });
});

describe("losClear (integer supercover)", () => {
  it("is clear across an open field and blocked by any cell the segment enters", () => {
    const a = cellCenter({ x: 1, y: 1 });
    const b = cellCenter({ x: 9, y: 4 });
    expect(losClear(emptyGrid(), a, b)).toBe(true);
    expect(losClear(gridWith([{ x: 5, y: 2 }]), a, b)).toBe(false);
    expect(losClear(gridWith([{ x: 5, y: 0 }]), a, b)).toBe(true);
  });

  it("treats a segment through an exact corner as touching all cells beyond it (no corner slipping)", () => {
    // Centre of (2,2) to centre of (4,4) passes exactly through the corner at (3,3)'s top-left.
    const a = cellCenter({ x: 2, y: 2 });
    const b = cellCenter({ x: 4, y: 4 });
    expect(losClear(emptyGrid(), a, b)).toBe(true);
    expect(losClear(gridWith([{ x: 3, y: 2 }]), a, b)).toBe(false);
    expect(losClear(gridWith([{ x: 2, y: 3 }]), a, b)).toBe(false);
    expect(losClear(gridWith([{ x: 3, y: 3 }]), a, b)).toBe(false);
  });

  it("handles axis-aligned segments and a start exactly on a boundary", () => {
    const g = gridWith([{ x: 5, y: 3 }]);
    expect(losClear(g, cellCenter({ x: 1, y: 3 }), cellCenter({ x: 8, y: 3 }))).toBe(false);
    expect(losClear(g, cellCenter({ x: 1, y: 4 }), cellCenter({ x: 8, y: 4 }))).toBe(true);
    expect(losClear(g, { x: 5 * 1024 as never, y: 3 * 1024 + 512 as never }, cellCenter({ x: 2, y: 3 }))).toBe(false);
    expect(losClear(emptyGrid(), { x: 5 * 1024 as never, y: 3 * 1024 + 512 as never }, cellCenter({ x: 2, y: 3 }))).toBe(true);
  });
});

describe("smoothPath (string pulling)", () => {
  it("collapses an open-field staircase to a single waypoint at the goal", () => {
    const g = emptyGrid();
    const steps = findPath(g, { x: 2, y: 3 }, { x: 6, y: 5 }, noBreach)!;
    const wps = smoothPath(g, cellCenter({ x: 2, y: 3 }), steps);
    expect(wps).toEqual([{ ...cellCenter({ x: 6, y: 5 }), breach: -1 }]);
  });

  it("keeps the cell adjacent to a breach and the breach itself as hard waypoints", () => {
    const fences = [];
    for (let x = 1; x < 32; x++) fences.push({ cell: { x, y: 10 }, index: x });
    const g = gridWith([], fences);
    const steps = findPath(g, { x: 13, y: 7 }, { x: 15, y: 12 }, () => 0)!;
    const wps = smoothPath(g, cellCenter({ x: 13, y: 7 }), steps);
    const breachAt = wps.findIndex((w) => w.breach >= 0);
    expect(breachAt).toBeGreaterThan(0);
    const before = wps[breachAt - 1]!;
    const breach = wps[breachAt]!;
    expect(breach.y).toBe(10 * 1024 + 512);
    expect(before.y).toBe(9 * 1024 + 512);
    expect(before.x).toBe(breach.x);
    for (let i = 1; i < wps.length; i++) {
      if (wps[i]!.breach >= 0) continue;
      const from = wps[i - 1]!;
      const gridAfter = from.breach >= 0 ? (() => { const h = new Int32Array(g); h[cellKey({ x: Math.floor(from.x / 1024), y: Math.floor(from.y / 1024) })] = -1; return h; })() : g;
      expect(losClear(gridAfter, from, wps[i]!)).toBe(true);
    }
  });

  it("never produces a leg that crosses a blocked cell", () => {
    const wall: Cell[] = [];
    for (let x = 3; x <= 12; x++) wall.push({ x, y: 7 });
    const g = gridWith(wall);
    const from = cellCenter({ x: 8, y: 4 });
    const wps = smoothPath(g, from, findPath(g, { x: 8, y: 4 }, { x: 8, y: 10 }, noBreach)!);
    let prev = from;
    for (const w of wps) {
      expect(losClear(g, prev, w)).toBe(true);
      prev = w;
    }
    expect(wps.length).toBeGreaterThanOrEqual(2);
  });
});
