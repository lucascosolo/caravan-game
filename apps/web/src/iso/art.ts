/**
 * The asset loader (PHASE-2 §26). `pnpm art:build` writes per-scene atlases at 1x/2x/3x
 * (WebP + PNG) to public/art and a manifest to src/art/generated/manifest.json; both are
 * gitignored build output. Without a build the manifest is absent and every type keeps its
 * placeholder skin. The loader picks the atlas for the renderer's resolution, tries WebP then
 * PNG, makes the raider copy of the unit frames (turquoise side pixels swapped to brick red),
 * and hands the scene a sprite SkinRegistry. Art is presentation only: nothing here is read by
 * the resolver or the server.
 */
import { ImageSource, Rectangle, Texture } from "pixi.js";
import { createSpriteSkins, type SkinRegistry, type SpriteFrame } from "./skins.ts";

export type ArtScene = "town" | "battle";

export interface ArtManifest {
  readonly version: 1;
  readonly assets: Record<string, { class: string; key: string; footprint: [number, number]; anchor: [number, number]; poses: Record<string, string[]> }>;
  readonly scenes: Partial<
    Record<
      ArtScene,
      {
        width: number;
        height: number;
        files: Partial<Record<"1" | "2" | "3", { webp: string; png: string; bytes: { webp: number; png: number } }>>;
        /** Frame id "class/key" → rectangle in art px. */
        frames: Record<string, { x: number; y: number; w: number; h: number }>;
      }
    >
  >;
}

const found = import.meta.glob<ArtManifest>("../art/generated/manifest.json", { eager: true, import: "default" });
export const ART_MANIFEST: ArtManifest | null = Object.values(found)[0] ?? null;

/** The renderer's resolution (scene.ts); the atlas DPR follows it. Up to 3 (C3: the 3x atlas, painted sprites at native device size). */
export function renderResolution(): number {
  return Math.min(3,typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
}

export function atlasDpr(resolution: number): 1 | 2 | 3 {
  return Math.min(3, Math.max(1, Math.round(resolution))) as 1 | 2 | 3;
}

export function atlasUrls(manifest: ArtManifest | null, scene: ArtScene, dpr: 1 | 2 | 3): { webp: string; png: string } | null {
  const f = manifest?.scenes[scene]?.files[String(dpr) as "1" | "2" | "3"];
  return f ? { webp: f.webp, png: f.png } : null;
}

export async function loadAtlasImage<T>(urls: { webp: string; png: string }, loadImage: (url: string) => Promise<T>): Promise<{ image: T; format: "webp" | "png" } | null> {
  try {
    return { image: await loadImage(urls.webp), format: "webp" };
  } catch {
    try {
      return { image: await loadImage(urls.png), format: "png" };
    } catch {
      return null;
    }
  }
}

type Lab = [number, number, number];

function toLab(r: number, g: number, b: number): Lab {
  const f = (u: number): number => ((u /= 255) <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
  const R = f(r), G = f(g), B = f(b);
  const t = (v: number): number => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const fx = t((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), fy = t(0.2126 * R + 0.7152 * G + 0.0722 * B), fz = t((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function fromLab([l, a, b]: Lab): [number, number, number] {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const t = (v: number): number => (v ** 3 > 0.008856 ? v ** 3 : (v - 16 / 116) / 7.787);
  const X = t(fx) * 0.95047, Y = t(fy), Z = t(fz) * 1.08883;
  const u = (v: number): number => {
    const c = Math.max(0, Math.min(1, v));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  return [u(3.2406 * X - 1.5372 * Y - 0.4986 * Z), u(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), u(0.0557 * X - 0.204 * Y + 1.057 * Z)];
}

// Side colours (STYLE-GUIDE §4): settlers turquoise #4fb8b0/#247778, raiders brick red #ec5231/#a52d16.
const TURQ_LIT = toLab(0x4f, 0xb8, 0xb0), TURQ_SHADOW = toLab(0x24, 0x77, 0x78);
const BRICK_LIT = toLab(0xec, 0x52, 0x31), BRICK_SHADOW = toLab(0xa5, 0x2d, 0x16);

/** The turquoise side region, as the intake harmonises it (packages/art paint.ts `isSideLab`). */
function isSide([l, a, b]: Lab): boolean {
  return a < -12 && b < 2 && Math.hypot(a, b) > 18 && l > 25 && l < 85;
}

/** Swap turquoise side pixels inside `rect` to brick red in place, keeping their light/shadow value; returns the count changed. */
export function recolourSide(data: Uint8ClampedArray, width: number, rect: { x: number; y: number; w: number; h: number }): number {
  const cache = new Map<number, [number, number, number] | null>();
  let changed = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3]! === 0) continue;
      const k = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      let out = cache.get(k);
      if (out === undefined) {
        const L = toLab(data[i]!, data[i + 1]!, data[i + 2]!);
        if (isSide(L)) {
          const t = Math.max(0, Math.min(1, (L[0] - TURQ_SHADOW[0]) / (TURQ_LIT[0] - TURQ_SHADOW[0])));
          out = fromLab([0, 1, 2].map((c) => BRICK_SHADOW[c]! + t * (BRICK_LIT[c]! - BRICK_SHADOW[c]!)) as Lab);
        } else out = null;
        cache.set(k, out);
      }
      if (!out) continue;
      data[i] = out[0];
      data[i + 1] = out[1];
      data[i + 2] = out[2];
      changed++;
    }
  return changed;
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`art: could not load ${url}`));
    img.src = url;
  });
}

/** A copy of the atlas with every unit frame recoloured for the raider side; null without a 2D canvas. */
function raiderCopy(img: HTMLImageElement, frames: [string, { x: number; y: number; w: number; h: number }][], dpr: number): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  for (const [id, f] of frames) {
    if (!id.startsWith("units/")) continue;
    const r = { x: f.x * dpr, y: f.y * dpr, w: f.w * dpr, h: f.h * dpr };
    const px = ctx.getImageData(r.x, r.y, r.w, r.h);
    recolourSide(px.data, r.w, { x: 0, y: 0, w: r.w, h: r.h });
    ctx.putImageData(px, r.x, r.y);
  }
  return canvas;
}

/** Load the scene's atlas for this resolution and build its sprite registry; null keeps the placeholders. */
export async function loadSceneSkins(scene: ArtScene, resolution: number, manifest: ArtManifest | null = ART_MANIFEST): Promise<SkinRegistry | null> {
  const dpr = atlasDpr(resolution);
  const urls = atlasUrls(manifest, scene, dpr);
  const sc = manifest?.scenes[scene];
  if (!urls || !sc || !manifest) return null;
  const base = import.meta.env.BASE_URL;
  // A data: URL (the C3 harness inlines its atlas so it opens from file://) is used as is.
  const at = (u: string): string => (u.startsWith("data:") ? u : base + u);
  const loaded = await loadAtlasImage({ webp: at(urls.webp), png: at(urls.png) }, loadImageElement);
  if (!loaded) return null;
  const entries = Object.entries(sc.frames);
  const source = new ImageSource({ resource: loaded.image, resolution: dpr, scaleMode: "linear" });
  const raider = raiderCopy(loaded.image, entries, dpr);
  const raiderSource = raider ? new ImageSource({ resource: raider, resolution: dpr, scaleMode: "linear" }) : null;
  const frames = new Map<string, SpriteFrame>();
  for (const [id, f] of entries) {
    const asset = manifest.assets[id];
    if (!asset) continue;
    // Frames are in art px; a source at resolution `dpr` measures its width in art px too.
    const frame = new Rectangle(f.x, f.y, f.w, f.h);
    frames.set(id, {
      texture: new Texture({ source, frame }),
      raiderTexture: raiderSource && id.startsWith("units/") ? new Texture({ source: raiderSource, frame }) : null,
      anchor: { x: asset.anchor[0], y: asset.anchor[1] },
      size: { w: f.w, h: f.h },
    });
  }
  return createSpriteSkins(frames);
}
