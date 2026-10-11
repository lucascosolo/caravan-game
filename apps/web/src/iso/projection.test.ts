import { describe, expect, it } from "vitest";
import { hitTest } from "./hit.ts";
import {
  TILE_H,
  TILE_W,
  canvasToWorld,
  cellDiamond,
  cellToWorld,
  clampCamera,
  depthKey,
  fitCamera,
  fixedToWorld,
  isOnLattice,
  pinchCamera,
  project,
  snapToCell,
  unproject,
  worldToCanvas,
  zoomCameraAbout,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./projection.ts";
import { EMPTY_SCENE } from "./types.ts";

describe("isometric projection (2:1)", () => {
  it("is 2:1: a cell is TILE_W wide and TILE_W/2 tall", () => {
    expect(TILE_H).toBe(TILE_W / 2);
    const d = cellDiamond({ x: 0, y: 0 });
    const xs = d.map((p) => p.x);
    const ys = d.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(TILE_W);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(TILE_H);
  });

  it("unproject is the exact inverse of project", () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 3.5, y: 7.5 },
      { x: 31, y: 0 },
      { x: 0, y: 31 },
      { x: 15.25, y: 15.75 },
    ]) {
      const back = unproject(project(p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it("moving +x goes down-right and +y goes down-left on screen", () => {
    const o = project({ x: 0, y: 0 });
    const px = project({ x: 1, y: 0 });
    const py = project({ x: 0, y: 1 });
    expect(px.x).toBeGreaterThan(o.x);
    expect(px.y).toBeGreaterThan(o.y);
    expect(py.x).toBeLessThan(o.x);
    expect(py.y).toBeGreaterThan(o.y);
  });

  it("converts a cell to its centre and a fixed-point position to cells (the replay hook)", () => {
    expect(cellToWorld({ x: 3, y: 7 })).toEqual({ x: 3.5, y: 7.5 });
    expect(fixedToWorld({ x: 3 * 1024 + 512, y: 7 * 1024 + 512 })).toEqual({ x: 3.5, y: 7.5 });
  });
});

describe("depth sort", () => {
  it("orders by row + column: further down-right draws later (in front)", () => {
    expect(depthKey({ x: 2, y: 3 })).toBeLessThan(depthKey({ x: 3, y: 3 }));
    expect(depthKey({ x: 2, y: 3 })).toBeLessThan(depthKey({ x: 2, y: 4 }));
    expect(depthKey({ x: 1, y: 5 })).toBe(depthKey({ x: 5, y: 1 }));
  });
  it("a layer never outranks a whole cell", () => {
    expect(depthKey({ x: 1, y: 1 }, 3)).toBeLessThan(depthKey({ x: 1.5, y: 1 }, 0));
  });
});

describe("lattice snapping", () => {
  it("snaps a world point to the cell containing it (floor), on every side of the centre", () => {
    expect(snapToCell({ x: 3.01, y: 7.99 })).toEqual({ x: 3, y: 7 });
    expect(snapToCell({ x: 3.99, y: 7.01 })).toEqual({ x: 3, y: 7 });
    expect(snapToCell({ x: 4, y: 8 })).toEqual({ x: 4, y: 8 });
  });
  it("round-trips a cell centre through screen space and back to the same cell", () => {
    for (let x = 0; x < 32; x += 5) for (let y = 0; y < 32; y += 7) expect(snapToCell(unproject(project(cellToWorld({ x, y }))))).toEqual({ x, y });
  });
  it("knows when a point is off the lattice", () => {
    expect(isOnLattice({ x: -0.1, y: 5 }, 32, 32)).toBe(false);
    expect(isOnLattice({ x: 31.9, y: 31.9 }, 32, 32)).toBe(true);
    expect(isOnLattice({ x: 32, y: 0 }, 32, 32)).toBe(false);
  });
});

describe("camera", () => {
  it("fits the whole lattice in the viewport and centres it", () => {
    const cam = fitCamera(360, 300, 32, 32);
    const centre = worldToCanvas(cam, { x: 16, y: 16 });
    expect(centre.x).toBeCloseTo(180, 6);
    expect(centre.y).toBeCloseTo(150, 6);
    for (const corner of [
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 32, y: 32 },
      { x: 0, y: 32 },
    ]) {
      const s = worldToCanvas(cam, corner);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(360);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(300);
    }
  });

  it("canvasToWorld inverts worldToCanvas under any camera", () => {
    const cam = { offsetX: 123, offsetY: -45, zoom: 1.7 };
    const w = { x: 9.25, y: 20.5 };
    const c = worldToCanvas(cam, w);
    const back = canvasToWorld(cam, c.x, c.y);
    expect(back.x).toBeCloseTo(w.x, 9);
    expect(back.y).toBeCloseTo(w.y, 9);
  });

  it("zooming about a point keeps the world under that point fixed, within limits", () => {
    const cam = { offsetX: 50, offsetY: 60, zoom: 1 };
    const under = canvasToWorld(cam, 200, 100);
    const z = zoomCameraAbout(cam, 1.5, 200, 100);
    const after = canvasToWorld(z, 200, 100);
    expect(after.x).toBeCloseTo(under.x, 9);
    expect(after.y).toBeCloseTo(under.y, 9);
    expect(zoomCameraAbout(cam, 100, 0, 0).zoom).toBe(ZOOM_MAX);
    expect(zoomCameraAbout(cam, 0.001, 0, 0).zoom).toBe(ZOOM_MIN);
  });

  it("a pinch that doubles the finger distance doubles the zoom and follows the midpoint", () => {
    const cam = { offsetX: 0, offsetY: 0, zoom: 1 };
    const z = pinchCamera(cam, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 60, y: 110 }, { x: 260, y: 110 });
    expect(z.zoom).toBeCloseTo(2, 9);
    const mid = canvasToWorld(z, 160, 110);
    const midBefore = canvasToWorld(cam, 150, 100);
    expect(mid.x).toBeCloseTo(midBefore.x, 9);
    expect(mid.y).toBeCloseTo(midBefore.y, 9);
  });

  it("clamps so the lattice cannot be panned out of view", () => {
    const cam = clampCamera({ offsetX: 100000, offsetY: 100000, zoom: 1 }, 360, 300, 32, 32);
    const s = worldToCanvas(cam, { x: 0, y: 32 });
    expect(s.x).toBeLessThanOrEqual(360);
  });
});

describe("hit test", () => {
  const state = {
    ...EMPTY_SCENE,
    posts: [{ id: "u2", pos: { x: 5.5, y: 5.5 }, typeId: "t", mergeLevel: 1, stance: "guard" as const, hpFraction: 1, aggroRadius: 1, leashDistance: 1, attackRange: 1 }],
    traps: [{ id: "t0", pos: { x: 5.5, y: 5.5 }, typeId: "t" }],
    fences: [{ id: "f0", cell: { x: 10, y: 10 }, tierId: "x", hp: 1, maxHp: 1 }],
    attackers: [{ id: "a0", pos: { x: 20.5, y: 20.5 }, typeId: "t", mergeLevel: 1, stance: "core" as const, hpFraction: 1 }],
  };
  it("prefers posts over traps on the same cell, finds fences by cell and attackers last", () => {
    expect(hitTest(state, { x: 5.6, y: 5.4 })).toEqual({ kind: "post", id: "u2" });
    expect(hitTest(state, { x: 10.2, y: 10.9 })).toEqual({ kind: "fence", id: "f0" });
    expect(hitTest(state, { x: 20.5, y: 20.6 })).toEqual({ kind: "attacker", id: "a0" });
    expect(hitTest(state, { x: 1, y: 1 })).toBeNull();
  });
});
