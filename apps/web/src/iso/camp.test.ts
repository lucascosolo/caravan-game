import { CORE_CELLS, RING_ORDER, WAGONS } from "@caravan/circle";
import { describe, expect, it } from "vitest";
import {
  CAMP_GUTTER_PX,
  CAMP_PAD,
  CAMP_WIDTH_SHARE,
  campCamera,
  campFrameOf,
  ringSpanPx,
} from "./camp.ts";
import { TILE_H, cellToWorld, project, worldToCanvas } from "./projection.ts";

const geo = { ringOrder: RING_ORDER, coreCells: CORE_CELLS, wagons: WAGONS };
const frame = () => campFrameOf(geo);
const mean = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

describe("camp frame", () => {
  it("ring is the cell centre of every ring cell, in order", () => {
    const f = frame();
    expect(f.kind).toBe("camp");
    expect(f.ring).toHaveLength(RING_ORDER.length);
    f.ring.forEach((p, i) => expect(p).toEqual(cellToWorld(RING_ORDER[i]!)));
    expect(f.widthShare).toBe(CAMP_WIDTH_SHARE);
    expect(f.gutter).toBe(CAMP_GUTTER_PX);
  });

  it("box bounds the padded ring, wagons and core, plus the approach rows", () => {
    const f = campFrameOf(geo, 2);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of f.ring) {
      const s = project(p);
      xs.push(s.x - CAMP_PAD.ring, s.x + CAMP_PAD.ring);
      ys.push(s.y);
    }
    const core = CORE_CELLS.map(cellToWorld);
    const marks = [
      ...WAGONS.map((w) => mean(cellToWorld(w.cells[0]), cellToWorld(w.cells[1]))),
      { x: core.reduce((a, q) => a + q.x, 0) / core.length, y: core.reduce((a, q) => a + q.y, 0) / core.length },
    ];
    for (const m of marks) {
      const s = project(m);
      xs.push(s.x - CAMP_PAD.wagonSide, s.x + CAMP_PAD.wagonSide);
      ys.push(s.y - CAMP_PAD.wagonTop, s.y + CAMP_PAD.wagonBottom);
    }
    expect(f.box.minX).toBeCloseTo(Math.min(...xs), 9);
    expect(f.box.maxX).toBeCloseTo(Math.max(...xs), 9);
    expect(f.box.minY).toBeCloseTo(Math.min(...ys) - 2 * TILE_H, 9);
    expect(f.box.maxY).toBeCloseTo(Math.max(...ys) + 2 * TILE_H, 9);
  });

  it("approachCells grows the box by exactly approach*TILE_H top and bottom, x unchanged", () => {
    const a = campFrameOf(geo, 0).box;
    const b = campFrameOf(geo, 2).box;
    expect(b.minX).toBe(a.minX);
    expect(b.maxX).toBe(a.maxX);
    expect(a.minY - b.minY).toBeCloseTo(2 * TILE_H, 9);
    expect(b.maxY - a.maxY).toBeCloseTo(2 * TILE_H, 9);
  });

  it("is pure and deterministic", () => {
    expect(campFrameOf(geo)).toEqual(campFrameOf(geo));
    expect(campCamera(393, 700, frame())).toEqual(campCamera(393, 700, frame()));
  });
});

describe("camp camera", () => {
  it("portrait: the ring spans 88-92% of the viewport width", () => {
    const f = frame();
    const cam = campCamera(393, 700, f);
    const share = ringSpanPx(cam, f.ring) / 393;
    expect(share).toBeGreaterThanOrEqual(0.88);
    expect(share).toBeLessThanOrEqual(0.92);
  });

  it("ringSpanPx is the canvas x extent of the ring", () => {
    const f = frame();
    const cam = campCamera(393, 700, f);
    const xs = f.ring.map((p) => worldToCanvas(cam, p).x);
    expect(ringSpanPx(cam, f.ring)).toBeCloseTo(Math.max(...xs) - Math.min(...xs), 9);
  });

  for (const [vw, vh] of [
    [393, 700],
    [393, 852],
  ] as const) {
    it(`${vw}x${vh}: the whole box, ring and wagons sit inside the gutter`, () => {
      const f = frame();
      const cam = campCamera(vw, vh, f);
      const g = f.gutter;
      const e = 1e-6;
      const inside = (x: number, y: number) => {
        expect(x).toBeGreaterThanOrEqual(g - e);
        expect(x).toBeLessThanOrEqual(vw - g + e);
        expect(y).toBeGreaterThanOrEqual(g - e);
        expect(y).toBeLessThanOrEqual(vh - g + e);
      };
      for (const x of [f.box.minX, f.box.maxX])
        for (const y of [f.box.minY, f.box.maxY]) inside(x * cam.zoom + cam.offsetX, y * cam.zoom + cam.offsetY);
      for (const p of f.ring) {
        const s = worldToCanvas(cam, p);
        inside(s.x, s.y);
      }
      for (const w of WAGONS)
        for (const cell of w.cells) {
          const s = worldToCanvas(cam, cellToWorld(cell));
          inside(s.x, s.y);
        }
    });
  }

  it("wide-short viewport: height binds", () => {
    const f = frame();
    const cam = campCamera(1200, 300, f);
    const h = f.box.maxY - f.box.minY;
    expect(cam.zoom).toBeCloseTo((300 - 2 * f.gutter) / h, 9);
    expect(f.box.minY * cam.zoom + cam.offsetY).toBeGreaterThanOrEqual(f.gutter - 1e-6);
    expect(f.box.maxY * cam.zoom + cam.offsetY).toBeLessThanOrEqual(300 - f.gutter + 1e-6);
  });

  it("the box centre lands at the viewport centre", () => {
    const f = frame();
    for (const [vw, vh] of [
      [393, 700],
      [1200, 300],
    ] as const) {
      const cam = campCamera(vw, vh, f);
      const cx = (f.box.minX + f.box.maxX) / 2;
      const cy = (f.box.minY + f.box.maxY) / 2;
      expect(cx * cam.zoom + cam.offsetX).toBeCloseTo(vw / 2, 6);
      expect(cy * cam.zoom + cam.offsetY).toBeCloseTo(vh / 2, 6);
    }
  });
});
