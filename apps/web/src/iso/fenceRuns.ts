/**
 * Fence runs on the round ring (chunk 50 / C3): one post per fence cell, so segments can be
 * counted; rails as one smooth curve through the posts (Catmull-Rom through the ring's cell
 * centres), attached to a neighbouring wagon; a post next to an open ring position is a braced
 * end post, so a gap reads as a deliberate opening. Pure layout; scene.ts draws it.
 */
import { cellToWorld, type CellLike, type WorldPoint } from "./projection.ts";

export interface FenceRunFence {
  readonly id: string;
  readonly cell: CellLike;
  readonly broken?: boolean;
}
export interface FencePost {
  readonly id: string;
  readonly cell: CellLike;
  readonly pos: WorldPoint;
  readonly end: boolean;
  readonly braceDir: WorldPoint | null;
  readonly broken: boolean;
}
export interface FenceRail {
  readonly key: string;
  readonly from: WorldPoint;
  readonly to: WorldPoint;
  readonly points: readonly WorldPoint[];
  readonly broken: boolean;
  readonly mid: WorldPoint;
}

export const RAIL_SAMPLES = 6;

const k = (c: CellLike): string => `${c.x},${c.y}`;

function catmull(p0: WorldPoint, p1: WorldPoint, p2: WorldPoint, p3: WorldPoint, t: number): WorldPoint {
  const t2 = t * t, t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
}

export function fenceLayout(input: { readonly ringOrder: readonly CellLike[]; readonly wagonCells: readonly CellLike[]; readonly fences: readonly FenceRunFence[] }): { posts: FencePost[]; rails: FenceRail[] } {
  const ring = input.ringOrder;
  const n = ring.length;
  const index = new Map(ring.map((c, i) => [k(c), i]));
  const wagon = new Set(input.wagonCells.map(k));
  const fenceAt = new Map<number, FenceRunFence>();
  for (const f of input.fences) {
    const i = index.get(k(f.cell));
    if (i !== undefined) fenceAt.set(i, f);
  }
  const at = (i: number): number => ((i % n) + n) % n;
  const centre = (i: number): WorldPoint => cellToWorld(ring[at(i)]!);
  const open = (i: number): boolean => !fenceAt.has(at(i)) && !wagon.has(k(ring[at(i)]!));

  const posts: FencePost[] = [...fenceAt.keys()].sort((a, b) => a - b).map((i) => {
    const f = fenceAt.get(i)!;
    const pos = centre(i);
    const side = open(i - 1) ? i - 1 : open(i + 1) ? i + 1 : null;
    let braceDir: WorldPoint | null = null;
    if (side !== null) {
      const o = centre(side);
      const len = Math.hypot(o.x - pos.x, o.y - pos.y) || 1;
      braceDir = { x: (o.x - pos.x) / len, y: (o.y - pos.y) / len };
    }
    return { id: f.id, cell: ring[i]!, pos, end: side !== null, braceDir, broken: !!f.broken };
  });

  const rails: FenceRail[] = [];
  for (let i = 0; i < n; i++) {
    const j = at(i + 1);
    const a = fenceAt.get(i), b = fenceAt.get(j);
    if (!a && !b) continue;
    if ((!a && !wagon.has(k(ring[i]!))) || (!b && !wagon.has(k(ring[j]!)))) continue;
    const ci = centre(i), cj = centre(j);
    const from = a ? ci : { x: (ci.x + cj.x) / 2, y: (ci.y + cj.y) / 2 };
    const to = b ? cj : { x: (ci.x + cj.x) / 2, y: (ci.y + cj.y) / 2 };
    const points: WorldPoint[] = [];
    for (let s = 0; s <= RAIL_SAMPLES; s++) points.push(catmull(centre(i - 1), ci, cj, centre(i + 2), s / RAIL_SAMPLES));
    // A wagon end stops halfway: the curve's first / last half is resampled toward the attach point.
    if (!a || !b) {
      const lo = a ? 0 : 0.5, hi = b ? 1 : 0.5;
      for (let s = 0; s <= RAIL_SAMPLES; s++) points[s] = catmull(centre(i - 1), ci, cj, centre(i + 2), lo + ((hi - lo) * s) / RAIL_SAMPLES);
    }
    points[0] = from;
    points[RAIL_SAMPLES] = to;
    rails.push({ key: `${i}-${j}`, from, to, points, broken: !!a?.broken || !!b?.broken, mid: points[RAIL_SAMPLES / 2]! });
  }
  return { posts, rails };
}
