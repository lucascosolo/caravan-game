import { describe, expect, it } from "vitest";
import { harmonise, outline } from "../src/paint.ts";

type Img = { width: number; height: number; data: Uint8Array };
const blank = (w: number, h: number): Img => ({ width: w, height: h, data: new Uint8Array(w * h * 4) });
const put = (i: Img, x: number, y: number, c: number[]) => i.data.set(c, (y * i.width + x) * 4);
const at = (i: Img, x: number, y: number) => Array.from(i.data.slice((y * i.width + x) * 4, (y * i.width + x) * 4 + 4));

describe("harmonise", () => {
  it("leaves the colour unchanged at strength 0", () => {
    expect(harmonise([13, 200, 77], false, 0)).toEqual([13, 200, 77]);
  });
  it("leaves a palette colour unchanged at any strength", () => {
    for (const s of [0.3, 1]) expect(harmonise([0xce, 0x84, 0x45], false, s)).toEqual([0xce, 0x84, 0x45]);
  });
  it("moves a near-palette colour onto the palette at full strength", () => {
    expect(harmonise([0xcf, 0x85, 0x46], false, 1)).toEqual([0xce, 0x84, 0x45]);
  });
  it("snaps a turquoise unit pixel toward the side colours", () => {
    const c = harmonise([0x50, 0xb0, 0xb0], true, 1);
    const d = (t: number[]) => Math.hypot(c[0] - t[0]!, c[1] - t[1]!, c[2] - t[2]!);
    expect(Math.min(d([0x4f, 0xb8, 0xb0]), d([0x24, 0x77, 0x78]))).toBeLessThan(12);
  });
});

describe("outline", () => {
  const dark = [0x2a, 0x1a, 0x14];
  it("returns a new image of the same size and leaves the input alone", () => {
    const i = blank(5, 5);
    put(i, 2, 2, [200, 50, 50, 255]);
    const o = outline(i, 1);
    expect(o).not.toBe(i);
    expect([o.width, o.height]).toEqual([5, 5]);
    expect(at(i, 1, 2)[3]).toBe(0);
  });
  it("px=1 outlines orthogonal neighbours only", () => {
    const i = blank(5, 5);
    put(i, 2, 2, [200, 50, 50, 255]);
    const o = outline(i, 1);
    for (const [x, y] of [[1, 2], [3, 2], [2, 1], [2, 3]] as const) expect(at(o, x, y)).toEqual([...dark, 255]);
    for (const [x, y] of [[1, 1], [3, 3], [1, 3], [3, 1], [0, 2]] as const) expect(at(o, x, y)[3]).toBe(0);
  });
  it("keeps opaque pixels unchanged", () => {
    const i = blank(3, 3);
    put(i, 1, 1, [200, 50, 50, 255]);
    expect(at(outline(i, 1), 1, 1)).toEqual([200, 50, 50, 255]);
  });
  it("px=2 reaches two pixels out", () => {
    const i = blank(7, 7);
    put(i, 3, 3, [1, 2, 3, 255]);
    const o = outline(i, 2);
    expect(at(o, 5, 3)[3]).toBe(255);
    expect(at(o, 3, 1)[3]).toBe(255);
    expect(at(o, 6, 3)[3]).toBe(0);
  });
});
