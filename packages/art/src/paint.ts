/**
 * The "middle path" painting steps (docs/art/STYLE-GUIDE.md §1), ported from the look-test
 * reference implementation paint.py: trim and clean the generator's alpha, harmonise colours
 * a fraction of the way toward the §4 palette in CIELAB, grow a uniform #2a1a14 outline round
 * the alpha, and find the ground-contact anchor. Pure functions over straight-alpha RGBA.
 */

export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Tunable: how far colours move toward the palette (owner's pick, 2026-10-20). */
export const HARMONISE_STRENGTH = 0.35;
/** Tunable: outline width in device px per DPR (2 px on a 3x screen). */
export const OUTLINE_PX: Readonly<Record<1 | 2 | 3, number>> = { 1: 1, 2: 1, 3: 2 };
export const OUTLINE_RGB: readonly [number, number, number] = [0x2a, 0x1a, 0x14];
/** The master is stored at this DPR; atlases at 1x/2x/3x are rendered from it. */
export const MASTER_DPR = 3;

const PALETTE_HEX = [
  "5d3826", "fff6ce", "fec486", "da8c55", "a2622e", "683d16", "f9e5b0", "deb87b", "ce8445", "895225", "fcc83a", "c18a19",
  "626a7c", "3a4151", "aaa190", "756b5f", "82b14e", "4c7f39", "6086c2", "3c5c94", "f2c970", "dba654", "fddf93", "c28345",
  "a9b48e", "6f7c5e", "d9a196", "a46c66", "8f6b93", "5a4363", "5a5058", "3a3238", "9a9a4e", "686a32", "7aa66b", "52703d", "2a1a14",
];
const SIDE_HEX = ["4fb8b0", "247778"];

type Lab = readonly [number, number, number];

function hexRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const f = (u: number): number => {
    const v = u / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = f(r), G = f(g), B = f(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const t = (v: number): number => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const fx = t(X), fy = t(Y), fz = t(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb([l, a, b]: Lab): [number, number, number] {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const t = (v: number): number => (v ** 3 > 0.008856 ? v ** 3 : (v - 16 / 116) / 7.787);
  const X = t(fx) * 0.95047, Y = t(fy), Z = t(fz) * 1.08883;
  const u = (v: number): number => {
    const c = Math.max(0, Math.min(1, v));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  return [u(3.2406 * X - 1.5372 * Y - 0.4986 * Z), u(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), u(0.0557 * X - 0.204 * Y + 1.057 * Z)];
}

const BODY_LAB = PALETTE_HEX.map((h) => rgbToLab(...hexRgb(h)));
const SIDE_LAB = SIDE_HEX.map((h) => rgbToLab(...hexRgb(h)));

/** The turquoise side-colour region: green-blue hue, clearly chromatic (paint.py `is_side`). */
export function isSideLab([l, a, b]: Lab): boolean {
  return a < -12 && b < 2 && Math.hypot(a, b) > 18 && l > 25 && l < 85;
}

const d2 = (p: Lab, q: Lab): number => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

export function harmonise(rgb: readonly [number, number, number], isUnit: boolean, strength: number): [number, number, number] {
  const L = rgbToLab(rgb[0], rgb[1], rgb[2]);
  const pool = isUnit && isSideLab(L) ? SIDE_LAB : BODY_LAB;
  let best = pool[0]!;
  for (const p of pool) if (d2(L, p) < d2(L, best)) best = p;
  if (d2(L, best) < 1e-6) return [rgb[0], rgb[1], rgb[2]];
  return labToRgb([L[0] + strength * (best[0] - L[0]), L[1] + strength * (best[1] - L[1]), L[2] + strength * (best[2] - L[2])]);
}

export function harmoniseImage(img: Rgba, isUnit: boolean, strength: number): Rgba {
  const out = new Uint8Array(img.data);
  const cache = new Map<number, [number, number, number]>();
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3]! < 6) {
      out.fill(0, i, i + 4);
      continue;
    }
    const k = (out[i]! << 16) | (out[i + 1]! << 8) | out[i + 2]!;
    let c = cache.get(k);
    if (!c) cache.set(k, (c = harmonise([out[i]!, out[i + 1]!, out[i + 2]!], isUnit, strength)));
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
  }
  return { width: img.width, height: img.height, data: out };
}

/**
 * Drop alpha below 8, then remove stray specks: components (on a 4x-downsampled mask, joined
 * across 2 cells) smaller than 2% of the largest are cleared. Returns the image cropped to its
 * remaining content.
 */
export function trimClean(img: Rgba): Rgba {
  const { width: w, height: h } = img;
  const data = new Uint8Array(img.data);
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 8) data[i] = 0;
  const sw = Math.max(1, Math.floor(w / 4)), sh = Math.max(1, Math.floor(h / 4));
  const cellOf = (x: number, y: number): number => Math.min(sh - 1, Math.floor((y * sh) / h)) * sw + Math.min(sw - 1, Math.floor((x * sw) / w));
  const mask = new Uint8Array(sw * sh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3]! >= 8) mask[cellOf(x, y)] = 1;
  const comp = new Int32Array(sw * sh).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || comp[s]! >= 0) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      const cx = c % sw, cy = Math.floor(c / sw);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const qx = cx + dx, qy = cy + dy;
          if (qx < 0 || qy < 0 || qx >= sw || qy >= sh) continue;
          const q = qy * sw + qx;
          if (mask[q] && comp[q]! < 0) {
            comp[q] = id;
            stack.push(q);
          }
        }
    }
    sizes.push(n);
  }
  if (sizes.length === 0) throw new Error("trimClean: the image is fully transparent");
  const big = Math.max(...sizes);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      const id = comp[cellOf(x, y)]!;
      if (id < 0 || sizes[id]! < big * 0.02) data[i] = 0;
      if (data[i]! >= 8) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  return crop({ width: w, height: h, data }, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

export function crop(img: Rgba, x: number, y: number, cw: number, ch: number): Rgba {
  const out = new Uint8Array(cw * ch * 4);
  for (let r = 0; r < ch; r++) out.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + cw) * 4), r * cw * 4);
  return { width: cw, height: ch, data: out };
}

/** Grow a #2a1a14 outline round the alpha: a max filter over a disc of radius `px` (paint.py `disc_dilate`). */
export function outline(img: Rgba, px: number): Rgba {
  const { width: w, height: h, data } = img;
  const offsets: [number, number][] = [];
  for (let dy = -px; dy <= px; dy++) for (let dx = -px; dx <= px; dx++) if (dx * dx + dy * dy <= px * px + px * 0.6) offsets.push([dx, dy]);
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let grown = 0;
      for (const [dx, dy] of offsets) {
        const sx = x - dx, sy = y - dy;
        if (sx >= 0 && sy >= 0 && sx < w && sy < h) grown = Math.max(grown, data[(sy * w + sx) * 4 + 3]!);
      }
      const i = (y * w + x) * 4;
      // Source over the outline layer (straight alpha).
      const sa = data[i + 3]! / 255, da = grown / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round((data[i + c]! * sa + OUTLINE_RGB[c]! * da * (1 - sa)) / oa);
      out[i + 3] = Math.round(oa * 255);
    }
  return { width: w, height: h, data: out };
}

export type AnchorKind = "foot" | "wagon" | "centre";

/** Place `content` bottom-centred on a footprint canvas, leaving `margin` px for the outline. */
export function placeOnCanvas(content: Rgba, fw: number, fh: number, margin: number): Rgba {
  const data = new Uint8Array(fw * fh * 4);
  const ox = Math.floor((fw - content.width) / 2), oy = fh - margin - content.height;
  for (let r = 0; r < content.height; r++) data.set(content.data.subarray(r * content.width * 4, (r + 1) * content.width * 4), ((oy + r) * fw + ox) * 4);
  return { width: fw, height: fh, data };
}

/** The ground-contact point in device px of a placed (un-outlined) canvas. */
export function findAnchor(img: Rgba, kind: AnchorKind): [number, number] {
  const { width: w, height: h, data } = img;
  const solid = (x: number, y: number): boolean => data[(y * w + x) * 4 + 3]! >= 128;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (solid(x, y)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) throw new Error("findAnchor: no opaque pixels");
  if (kind === "foot") {
    const band = Math.max(1, Math.round((y1 - y0 + 1) * 0.04));
    let lo = w, hi = -1;
    for (let y = y1 - band + 1; y <= y1; y++)
      for (let x = 0; x < w; x++)
        if (solid(x, y)) {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
    return [(lo + hi + 1) / 2, y1 + 1];
  }
  if (kind === "wagon") return [(x0 + x1 + 1) / 2, y1 + 1 - Math.round((y1 - y0 + 1) * 0.16)];
  return [(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2];
}
