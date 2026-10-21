/**
 * The opening camera on the wagon circle (chunk 50, "the whole camp is visible by default on a
 * phone"). Pure: the camp's projected box from the round-ring geometry, and the camera that puts
 * the ring across ~90% of the viewport width while the whole camp (ring, wagons, vault wagon,
 * the near approach above and below) stays inside the gutter. Presentation only.
 */
import { TILE_H, cellToWorld, clampZoom, project, worldToCanvas, type Camera, type CellLike, type WorldPoint } from "./projection.ts";

/** Projected art px at zoom 1. */
export interface CampBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface CampFrame {
  readonly kind: "camp";
  readonly ring: readonly WorldPoint[];
  readonly box: CampBox;
  readonly widthShare: number;
  readonly gutter: number;
}

/** CAMP_FRAME tunables (presentation): the ring's share of the viewport width, the screen gutter. */
export const CAMP_WIDTH_SHARE = 0.9;
export const CAMP_GUTTER_PX = 16;
/** Sprite overhang around the camp's ground points, art px: a fence post's half width, a wagon's half width / height above / below its anchor. */
export const CAMP_PAD = { ring: 4, wagonSide: 35, wagonTop: 48, wagonBottom: 8 } as const;

const mean = (ps: readonly WorldPoint[]): WorldPoint => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

export function campFrameOf(
  geo: { readonly ringOrder: readonly CellLike[]; readonly coreCells: readonly CellLike[]; readonly wagons: readonly { readonly cells: readonly [CellLike, CellLike] }[] },
  approachCells = 2,
): CampFrame {
  const ring = geo.ringOrder.map(cellToWorld);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const add = (p: WorldPoint, side: number, top: number, bottom: number): void => {
    const s = project(p);
    minX = Math.min(minX, s.x - side);
    maxX = Math.max(maxX, s.x + side);
    minY = Math.min(minY, s.y - top);
    maxY = Math.max(maxY, s.y + bottom);
  };
  for (const p of ring) add(p, CAMP_PAD.ring, 0, 0);
  const tall = geo.wagons.map((w) => mean([cellToWorld(w.cells[0]), cellToWorld(w.cells[1])]));
  if (geo.coreCells.length > 0) tall.push(mean(geo.coreCells.map(cellToWorld)));
  for (const p of tall) add(p, CAMP_PAD.wagonSide, CAMP_PAD.wagonTop, CAMP_PAD.wagonBottom);
  const approach = approachCells * TILE_H;
  return { kind: "camp", ring, box: { minX, maxX, minY: minY - approach, maxY: maxY + approach }, widthShare: CAMP_WIDTH_SHARE, gutter: CAMP_GUTTER_PX };
}

export function campCamera(viewportW: number, viewportH: number, f: CampFrame): Camera {
  const xs = f.ring.map((p) => project(p).x);
  const ringSpan = Math.max(...xs) - Math.min(...xs);
  const bw = f.box.maxX - f.box.minX;
  const bh = f.box.maxY - f.box.minY;
  const zoom = clampZoom(Math.min((f.widthShare * viewportW) / ringSpan, (viewportW - 2 * f.gutter) / bw, (viewportH - 2 * f.gutter) / bh));
  const cx = (f.box.minX + f.box.maxX) / 2;
  const cy = (f.box.minY + f.box.maxY) / 2;
  return { zoom, offsetX: viewportW / 2 - cx * zoom, offsetY: viewportH / 2 - cy * zoom };
}

/** The ring's on-screen width under a camera, CSS px (the measured "ring share" numerator). */
export function ringSpanPx(cam: Camera, ring: readonly WorldPoint[]): number {
  const xs = ring.map((p) => worldToCanvas(cam, p).x);
  return Math.max(...xs) - Math.min(...xs);
}
