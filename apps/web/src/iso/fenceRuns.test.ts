import { RING_ORDER, WAGONS } from "@caravan/circle";
import { describe, expect, it } from "vitest";
import { RAIL_SAMPLES, fenceLayout, type FenceRunFence } from "./fenceRuns.ts";

// 3x3 square border, 8 cells in cyclic order.
const R = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 1 },
  { x: 2, y: 2 },
  { x: 1, y: 2 },
  { x: 0, y: 2 },
  { x: 0, y: 1 },
];
const c = (cell: { x: number; y: number }) => ({ x: cell.x + 0.5, y: cell.y + 0.5 });
const fences = (idx: number[], broken: number[] = []): FenceRunFence[] =>
  idx.map((i) => ({ id: `f${i}`, cell: R[i]!, broken: broken.includes(i) }));
const layout = (f: number[], wagons: number[] = [], broken: number[] = []) =>
  fenceLayout({ ringOrder: R, wagonCells: wagons.map((i) => R[i]!), fences: fences(f, broken) });
const keys = (l: ReturnType<typeof layout>) => l.rails.map((r) => r.key).sort();

describe("fenceLayout posts (synthetic ring)", () => {
  it("one post per fence at the cell centre, sorted by ring index, broken flag carried", () => {
    const l = layout([5, 1, 3], [], [3]);
    expect(l.posts.map((p) => p.id)).toEqual(["f1", "f3", "f5"]);
    expect(l.posts.map((p) => p.pos)).toEqual([c(R[1]!), c(R[3]!), c(R[5]!)]);
    expect(l.posts.map((p) => p.broken)).toEqual([false, true, false]);
    expect(l.posts[0]!.cell).toEqual(R[1]);
  });

  it("a fence off the ring is ignored", () => {
    const l = fenceLayout({
      ringOrder: R,
      wagonCells: [],
      fences: [...fences([1]), { id: "stray", cell: { x: 1, y: 1 } }],
    });
    expect(l.posts.map((p) => p.id)).toEqual(["f1"]);
  });

  it("ends are posts with an open neighbour; braceDir is the unit vector toward it", () => {
    const [p1, p2, p3] = layout([1, 2, 3], [0]).posts;
    expect([p1!.end, p2!.end, p3!.end]).toEqual([false, false, true]);
    expect(p1!.braceDir).toBeNull();
    expect(p2!.braceDir).toBeNull();
    expect(p3!.braceDir!.x).toBeCloseTo(0, 9);
    expect(p3!.braceDir!.y).toBeCloseTo(1, 9); // toward ring[4] at (2,2)
  });

  it("an isolated post checks i-1 before i+1", () => {
    const [p] = layout([5]).posts;
    expect(p!.end).toBe(true);
    expect(p!.braceDir!.x).toBeCloseTo(1, 9);
    expect(p!.braceDir!.y).toBeCloseTo(0, 9); // toward ring[4] at (2,2)
  });

  it("neighbour lookup wraps cyclically", () => {
    const [p] = layout([0], [7]).posts; // i-1 = 7 is a wagon, i+1 = 1 is open
    expect(p!.end).toBe(true);
    expect(p!.braceDir!.x).toBeCloseTo(1, 9);
    expect(p!.braceDir!.y).toBeCloseTo(0, 9);
  });
});

describe("fenceLayout rails (synthetic ring)", () => {
  it("rails join fence-fence and fence-wagon neighbours only", () => {
    expect(keys(layout([1, 2, 3], [0]))).toEqual(["0-1", "1-2", "2-3"]);
  });

  it("no rail between two wagon cells or touching an open position", () => {
    expect(keys(layout([3], [0, 1]))).toEqual([]);
    expect(keys(layout([2], [1, 3]))).toEqual(["1-2", "2-3"]);
    expect(keys(layout([1, 5]))).toEqual([]);
  });

  it("fence-fence rail runs between the two cell centres", () => {
    const r = layout([1, 2]).rails.find((x) => x.key === "1-2")!;
    expect(r.from).toEqual(c(R[1]!));
    expect(r.to).toEqual(c(R[2]!));
  });

  it("wagon end attaches at the midpoint of wagon and fence centres", () => {
    const a = layout([1], [0]).rails.find((x) => x.key === "0-1")!;
    expect(a.from).toEqual({ x: 1, y: 0.5 });
    expect(a.to).toEqual(c(R[1]!));
    const b = layout([1], [2]).rails.find((x) => x.key === "1-2")!;
    expect(b.from).toEqual(c(R[1]!));
    expect(b.to).toEqual({ x: 2, y: 0.5 });
  });

  it("wraps cyclically: last and first join as 7-0", () => {
    const l = layout([7, 0]);
    expect(keys(l)).toEqual(["7-0"]);
    expect(l.rails[0]!.from).toEqual(c(R[7]!));
    expect(l.rails[0]!.to).toEqual(c(R[0]!));
  });

  it("broken if either fence endpoint is broken", () => {
    const by = Object.fromEntries(layout([1, 2, 3], [0], [2]).rails.map((r) => [r.key, r.broken]));
    expect(by).toEqual({ "0-1": false, "1-2": true, "2-3": true });
  });

  it("curve: RAIL_SAMPLES+1 points, exact endpoints, within half a cell of the chord, mid is the centre sample", () => {
    expect(RAIL_SAMPLES).toBe(6);
    const l = layout([1, 2, 3, 4, 5, 6, 7, 0]);
    expect(l.rails).toHaveLength(8);
    for (const r of l.rails) {
      expect(r.points).toHaveLength(RAIL_SAMPLES + 1);
      expect(r.points[0]).toEqual(r.from);
      expect(r.points[RAIL_SAMPLES]).toEqual(r.to);
      expect(r.mid).toEqual(r.points[RAIL_SAMPLES / 2]);
      const dx = r.to.x - r.from.x;
      const dy = r.to.y - r.from.y;
      const len2 = dx * dx + dy * dy;
      for (const p of r.points) {
        const t = Math.max(0, Math.min(1, ((p.x - r.from.x) * dx + (p.y - r.from.y) * dy) / len2));
        expect(Math.hypot(p.x - (r.from.x + t * dx), p.y - (r.from.y + t * dy))).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });
});

describe("fenceLayout on the real ring", () => {
  it("every non-wagon cell fenced: no ends, a rail for every adjacent pair not both wagons", () => {
    const wagonCells = WAGONS.flatMap((w) => [...w.cells]);
    const isWagon = (cell: { x: number; y: number }) => wagonCells.some((w) => w.x === cell.x && w.y === cell.y);
    const fenceCells = RING_ORDER.filter((cell) => !isWagon(cell));
    const l = fenceLayout({
      ringOrder: RING_ORDER,
      wagonCells,
      fences: fenceCells.map((cell, i) => ({ id: `r${i}`, cell })),
    });
    const n = RING_ORDER.length;
    let pairs = 0;
    for (let i = 0; i < n; i++) if (!(isWagon(RING_ORDER[i]!) && isWagon(RING_ORDER[(i + 1) % n]!))) pairs++;
    expect(l.posts).toHaveLength(fenceCells.length);
    expect(l.posts.every((p) => !p.end && p.braceDir === null)).toBe(true);
    expect(l.rails).toHaveLength(pairs);
    expect(new Set(l.rails.map((r) => r.key)).size).toBe(pairs);
  });
});
