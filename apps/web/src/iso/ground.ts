/**
 * The baked camp ground (C3, ported from the approved look test): one pixel-art layer under
 * everything — packed-dirt camp floor inside the ring with worn lanes, the trail's twin wheel
 * ruts coming in from the top, a dry wash across the lower left, sparse low-contrast sand
 * patches, grass tufts, pebbles, and a few rocks, sage and cacti outside the camp and the
 * approach. Every value comes from a position hash, so the same geometry bakes the same
 * ground. Pure (no DOM): scene.ts puts the pixels on a canvas.
 *
 * Presentation only; the resolver never sees any of it. `density` is ground pixels per art px:
 * the scene picks it so one ground pixel is a whole number of device pixels at the opening zoom.
 */
import { cellToWorld, project, unproject, type CellLike, type WorldPoint } from "./projection.ts";

export interface GroundSpec {
  readonly width: number;
  readonly height: number;
  readonly ringOrder: readonly CellLike[];
  readonly coreCells: readonly CellLike[];
}

export interface GroundPixels {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly w: number;
  readonly h: number;
  /** Top-left of the baked rectangle, projected art px at zoom 1. */
  readonly x0: number;
  readonly y0: number;
  readonly density: number;
}

/** GROUND palette (STYLE-GUIDE §4 desert family, the look test's warm sand). */
export const GROUND = {
  sand: 0xebc47a,
  sandLight: 0xf2d290,
  sandDark: 0xdfb56d,
  floor: 0xd9a563,
  floorDark: 0xcc9655,
  lane: 0xbf8a4c,
  berm: 0xd09b5a,
  rut: 0xb98450,
  rutLip: 0xf6dc9c,
  wash: 0xc98f55,
  washLight: 0xd6a066,
  crack: 0x9a6438,
  bank: 0xcf9d5e,
} as const;

/** Margin baked around the lattice, cells. */
const MARGIN = 3;

function hash(i: number, j: number, s = 0): number {
  let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(s, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function octave(x: number, y: number, seed: number): number {
  return (valueNoise(x, y, seed) * 4 + valueNoise(x * 2.1, y * 2.1, seed + 1) * 2 + valueNoise(x * 4.3, y * 4.3, seed + 2)) / 7;
}

function catmull(p: readonly WorldPoint[], n: number): WorldPoint[] {
  const out: WorldPoint[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)]!, p1 = p[i]!, p2 = p[i + 1]!, p3 = p[Math.min(p.length - 1, i + 2)]!;
    for (let s = 0; s < n; s++) {
      const t = s / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(p[p.length - 1]!);
  return out;
}

/** Distance (world cells) from q to a polyline, and the side (sign of the cross product). */
function polyDist(poly: readonly WorldPoint[], q: WorldPoint): { d: number; side: number; t: number } {
  let best = { d: Infinity, side: 0, t: 0 };
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i]!, b = poly[i + 1]!;
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    const u = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / len2));
    const dx = q.x - (a.x + u * vx), dy = q.y - (a.y + u * vy);
    const d = Math.hypot(dx, dy);
    if (d < best.d) best = { d, side: Math.sign(vx * dy - vy * dx), t: (i + u) / (poly.length - 1) };
  }
  return best;
}

/** Pixel stamps from the look test (one char per colour, '.' empty). */
const STAMP_COLOURS: Record<string, number> = { O: 0x2b1d18, e: 0x86ad5a, E: 0x527d42, c: 0xf3e2b5, x: 0xfff3d1, k: 0xa8a092, K: 0x746c62, a: 0xa9b48e, A: 0x6f7c5e, h: 0x9a6438, Y: 0xd2a660, d: 0xb98450, v: 0x7aa66b, V: 0x52703d };
const CACTUS = ["......OO......", ".....OcxO.....", "....OeeeEO....", "....OeeeEO....", "..O.OeEeEO....", ".OeOOeEeEO....", "OeeEOeEeEO.O..", "OeeEOeEeEOOeO.", "OeEEOeEeEOeeEO", "OeEEOeEeEOeEEO", "OeEEOeEeEOeEEO", "OeEEOeEeEOeEEO", "OeeeeeEeEOeEEO", ".OEEEeEeEeeEEO", "..OOOeEeEEEEO.", "....OeEeEOOO..", "....OeEeEO....", "....OeEeEO....", "....OeEeEO....", "....OeEeEO....", "....OeEeEO....", "....OeEeEO....", "....OeEEEO....", ".....OOOO....."];
const ROCK = [".....OOOO.....", "...OOkkkkOO...", "..OkxxkkkkKO..", ".OkkkkkkkkKKO.", "OkkkkkkkkkKKKO", "OkkKkkkkkKKKKO", "OkkkKkkkKKKKKO", "OKkkkkKKKKKKKO", ".OKKKKKKKKKKO.", "..OOOOOOOOOO.."];
const SAGE = ["...OO...OO....", "..OaaO.OaaOOO.", ".OaaaAOaaaAaaO", "OaaaAAaaaAAaAO", "OaaAAaaaAAAaAO", "OaAAAaAAAAAAAO", ".OAAAAhAAAAAO.", "..OOOhhhhOOO..", ".....OOOO....."];
const TUFTS = [["e..e.", "e.eE.", "EeEEE"], [".e..", "eE.e", "EEeE"], ["e.e", "EeE"], ["v..v", "v.vV", "VvV."]];
const PEBBLES = [["kk.", "KKY"], ["k.", "KY"], [".k.", "kKY"]];

/** Props outside the camp, world cells relative to the core centre: [dx, dy, kind]. Fixed, never random. */
const PROPS: readonly [number, number, "cactus" | "rock" | "sage"][] = [
  [-9, -4, "cactus"], [-8.4, -3.2, "rock"], [-13, -9, "sage"], [-6, -11, "rock"], [-15, -12, "cactus"],
  [9, 4.5, "cactus"], [9.8, 5.6, "rock"], [7.5, 9.5, "sage"], [12, 8.5, "rock"], [13.5, 10.5, "cactus"], [5, 12, "rock"],
  [-4.5, 9.5, "sage"], [-1, 15, "rock"], [16, 12, "sage"], [-11, -12.5, "rock"], [3, -12, "sage"],
];

export function groundPixels(spec: GroundSpec, density: number): GroundPixels {
  const corners = [project({ x: -MARGIN, y: -MARGIN }), project({ x: spec.width + MARGIN, y: -MARGIN }), project({ x: spec.width + MARGIN, y: spec.height + MARGIN }), project({ x: -MARGIN, y: spec.height + MARGIN })];
  const x0 = Math.floor(Math.min(...corners.map((c) => c.x)));
  const y0 = Math.floor(Math.min(...corners.map((c) => c.y)));
  const w = Math.ceil((Math.max(...corners.map((c) => c.x)) - x0) * density);
  const h = Math.ceil((Math.max(...corners.map((c) => c.y)) - y0) * density);
  const data = new Uint8ClampedArray(w * h * 4);

  const core = spec.coreCells.map(cellToWorld);
  const C = core.length > 0 ? { x: core.reduce((s, p) => s + p.x, 0) / core.length, y: core.reduce((s, p) => s + p.y, 0) / core.length } : { x: spec.width / 2, y: spec.height / 2 };
  const ring = spec.ringOrder.map(cellToWorld).map((p) => ({ a: Math.atan2(p.y - C.y, p.x - C.x), r: Math.hypot(p.x - C.x, p.y - C.y) })).sort((a, b) => a.a - b.a);
  const ringR = (a: number): number => {
    if (ring.length === 0) return 0;
    let i = ring.findIndex((p) => p.a > a);
    if (i < 0) i = 0;
    const hi = ring[i]!, lo = ring[(i - 1 + ring.length) % ring.length]!;
    let span = hi.a - lo.a;
    if (span <= 0) span += 2 * Math.PI;
    let t = a - lo.a;
    if (t < 0) t += 2 * Math.PI;
    return lo.r + (hi.r - lo.r) * Math.min(1, t / span);
  };
  const R0 = ring.length ? ring.reduce((s, p) => s + p.r, 0) / ring.length : 5;
  const rel = (dx: number, dy: number): WorldPoint => ({ x: C.x + dx, y: C.y + dy });
  // The trail the caravan came in on (screen top), its twin ruts 0.55 cell apart; the dry wash (screen lower left); worn lanes on the floor.
  const trail = catmull([rel(-2.5, -20), rel(-3.2, -13), rel(-3.6, -8.5), rel(-3.4, -5.6), rel(-2.2, -3.2)], 12);
  const wash = catmull([rel(2.2, 8.2), rel(1.2, 11), rel(-0.6, 13.6), rel(0.4, 17), rel(-1.2, 21), rel(-0.4, 26)], 14);
  const lanes = [
    catmull([C, rel(-1.6, 0.8), rel(-3.2, 1.2), rel(-4.6, 2.2)], 8),
    catmull([C, rel(1.2, 1.4), rel(2.6, 3.1), rel(3.6, 4.4)], 8),
    catmull([rel(0.5, -0.8), rel(0.2, -2.4), rel(-1.6, -3.6), rel(-2.2, -3.2)], 8),
    catmull([C, rel(1.8, -0.6), rel(3.4, -0.4), rel(4.6, -1.2)], 8),
  ];

  const put = (i: number, c: number): void => {
    data[i] = (c >> 16) & 255;
    data[i + 1] = (c >> 8) & 255;
    data[i + 2] = c & 255;
    data[i + 3] = 255;
  };
  const near = (p: WorldPoint, poly: readonly WorldPoint[], pad: number): boolean => {
    const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
    return p.x > Math.min(...xs) - pad && p.x < Math.max(...xs) + pad && p.y > Math.min(...ys) - pad && p.y < Math.max(...ys) + pad;
  };
  const trailBox = (p: WorldPoint): boolean => near(p, trail, 1);
  const washBox = (p: WorldPoint): boolean => near(p, wash, 2);
  const px1 = 1 / density; // one ground pixel in art px
  const cellPx = 1 / (density * 20); // ~ one ground pixel in world cells (TILE_H 20 is the finer axis)

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      const q = unproject({ x: x0 + (px + 0.5) * px1, y: y0 + (py + 0.5) * px1 });
      const dx = q.x - C.x, dy = q.y - C.y;
      const r = Math.hypot(dx, dy);
      const R = ringR(Math.atan2(dy, dx));
      // 1. sand: sparse, low-contrast patches from a slow noise, quantized to three tones.
      const n = octave(q.x / 3.2, q.y / 3.2, 7);
      let c: number = n > 0.7 ? GROUND.sandDark : n < 0.24 ? GROUND.sandLight : GROUND.sand;
      // 2. the berm and the packed-dirt floor inside the ring, its edge ragged.
      const edge = R - 0.15 + (octave(q.x * 1.3, q.y * 1.3, 11) - 0.5) * 0.9;
      if (r < edge + 0.5 && r >= edge) c = GROUND.berm;
      if (r < edge) {
        const f = octave(q.x * 0.9, q.y * 0.9, 13);
        c = f > 0.62 ? GROUND.floorDark : GROUND.floor;
        for (const lane of lanes) {
          const L = polyDist(lane, q);
          if (L.d < 0.16 + (octave(q.x * 2, q.y * 2, 17) - 0.5) * 0.2) c = GROUND.lane;
        }
      }
      // 3. the dry wash: cracked mud plates, a shaded upper bank, a lit lower lip.
      if (washBox(q) && r > R0 + 1.5) {
        const W = polyDist(wash, q);
        const half = 0.75 + (octave(q.x, q.y, 19) - 0.5) * 0.5;
        if (W.d < half) {
          const gx = q.x * 3, gy = q.y * 3;
          let d1 = 9, d2 = 9;
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const cx = Math.floor(gx) + ox, cy = Math.floor(gy) + oy;
              const sx = cx + hash(cx, cy, 23), sy = cy + hash(cx, cy, 29);
              const d = Math.hypot(gx - sx, gy - sy);
              if (d < d1) [d2, d1] = [d1, d];
              else if (d < d2) d2 = d;
            }
          c = d2 - d1 < cellPx * 3 * 1.6 ? GROUND.crack : hash(Math.floor(gx), Math.floor(gy), 31) > 0.7 ? GROUND.washLight : GROUND.wash;
        } else if (W.d < half + 0.22) c = W.side > 0 ? GROUND.bank : GROUND.sandLight;
      }
      // 4. the trail's twin wheel ruts, outside the floor (a fence may stand across them: the caravan came in, then closed up).
      if (trailBox(q) && r > edge) {
        const T = polyDist(trail, q);
        const off = Math.abs(T.d - 0.28);
        if (off < cellPx * 2.2) c = GROUND.rut;
        else if (off < cellPx * 3.4 && T.d > 0.28) c = GROUND.rutLip;
      }
      put(i, c);
    }
  }

  // 5. stamps: tufts and pebbles on a hashed scatter (none on the floor), then the props.
  const stamp = (gx: number, gy: number, rows: readonly string[], scale: number, anchorX: number, anchorY: number): void => {
    for (let y = 0; y < rows.length; y++)
      for (let x = 0; x < rows[y]!.length; x++) {
        const ch = rows[y]![x]!;
        if (ch === ".") continue;
        const col = STAMP_COLOURS[ch];
        if (col === undefined) continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) {
            const X = gx + (x - anchorX) * scale + sx, Y = gy + (y - anchorY) * scale + sy;
            if (X >= 0 && Y >= 0 && X < w && Y < h) put((Y * w + X) * 4, col);
          }
      }
  };
  const toGround = (p: WorldPoint): [number, number] => {
    const s = project(p);
    return [Math.round((s.x - x0) * density), Math.round((s.y - y0) * density)];
  };
  const step = 0.55;
  for (let wy = -MARGIN; wy < spec.height + MARGIN; wy += step)
    for (let wx = -MARGIN; wx < spec.width + MARGIN; wx += step) {
      const ix = Math.round(wx / step), iy = Math.round(wy / step);
      const hv = hash(ix, iy, 41);
      const p = { x: wx + hash(ix, iy, 43) * step, y: wy + hash(ix, iy, 47) * step };
      const r = Math.hypot(p.x - C.x, p.y - C.y);
      if (r < R0 + 0.8) continue;
      const lush = polyDist(wash, p).d < 1.6 || (r > R0 + 0.8 && r < R0 + 1.6);
      const [gx, gy] = toGround(p);
      if (hv < (lush ? 0.16 : 0.035)) stamp(gx, gy, TUFTS[Math.floor(hash(ix, iy, 53) * TUFTS.length)]!, 1, 2, 2);
      else if (hv > 0.975) stamp(gx, gy, PEBBLES[Math.floor(hash(ix, iy, 59) * PEBBLES.length)]!, 1, 1, 1);
    }
  for (const [ddx, ddy, kind] of PROPS) {
    const p = rel(ddx, ddy);
    if (p.x < -MARGIN || p.y < -MARGIN || p.x > spec.width + MARGIN || p.y > spec.height + MARGIN) continue;
    const [gx, gy] = toGround(p);
    const rows = kind === "cactus" ? CACTUS : kind === "rock" ? ROCK : SAGE;
    const scale = Math.max(1, Math.round(density * 1.5));
    stamp(gx, gy, rows, scale, 7, rows.length - 1);
  }
  return { data, w, h, x0, y0, density };
}
