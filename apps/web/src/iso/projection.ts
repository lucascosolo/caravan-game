/**
 * Isometric projection, depth ordering and lattice snapping — PURE functions, no PixiJS
 * (chunk 08, "the shared isometric scene renderer"). Everything the scene draws goes
 * through `project`; everything a pointer touches comes back through `unproject`.
 *
 * Two spaces, kept apart on purpose (GUARDRAILS "The simulation model"):
 *   - WORLD space: continuous cell units. `{x: 3.5, y: 7.5}` is the centre of cell (3, 7).
 *     A placed cell becomes a world point through `cellToWorld` (the centre); a fixed-point
 *     simulation position (chunk 10's `FixedPoint`, 1/1024 cell) becomes one through
 *     `fixedToWorld` — that is the hook the battle replay (chunk 22) interpolates through.
 *   - SCREEN space: pixels in the scene's world container, before the camera transform.
 *
 * The projection is the standard 2:1 isometric (PROJECTION tunable): a cell is a diamond
 * TILE_W wide and TILE_H = TILE_W / 2 tall. Depth order is the painter's algorithm over
 * (row + column) — DEPTH_SORT tunable — so a thing further "down-right" in world space is
 * drawn later and therefore in front.
 *
 * Floats are fine here: this is presentation, never simulation. Nothing in this module may
 * ever feed a number back into the resolver.
 */
import { FIXED_POINT_SCALE } from "@caravan/content";

/** PROJECTION tunable: 2:1 isometric. Tile width in screen pixels at zoom 1 (height is half). */
export const TILE_W = 48;
export const TILE_H = TILE_W / 2;

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}
export interface CellLike {
  readonly x: number;
  readonly y: number;
}

/** World (continuous cells) → screen pixels at zoom 1, origin at world (0, 0). */
export function project(p: WorldPoint): ScreenPoint {
  return { x: (p.x - p.y) * (TILE_W / 2), y: (p.x + p.y) * (TILE_H / 2) };
}

/** Screen pixels → world (continuous cells). Exact inverse of `project`. */
export function unproject(s: ScreenPoint): WorldPoint {
  const a = s.x / (TILE_W / 2);
  const b = s.y / (TILE_H / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** The centre of a lattice cell in world space. */
export function cellToWorld(cell: CellLike): WorldPoint {
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

/** A fixed-point simulation position (1/FIXED_POINT_SCALE cell) in world space. Replay hook. */
export function fixedToWorld(p: { readonly x: number; readonly y: number }): WorldPoint {
  return { x: p.x / FIXED_POINT_SCALE, y: p.y / FIXED_POINT_SCALE };
}

/** The lattice cell containing a world point (floor). The snap rule for a drag. */
export function snapToCell(p: WorldPoint): CellLike {
  return { x: Math.floor(p.x), y: Math.floor(p.y) };
}

/** Whether a world point lies on the lattice at all (so a drop outside it is "nowhere"). */
export function isOnLattice(p: WorldPoint, width: number, height: number): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;
}

/**
 * DEPTH_SORT tunable: painter's order over (row + column). Larger draws later (in front).
 * The `layer` term breaks ties within one cell: ground decals (0) under a trap (1) under a
 * unit (2) under a floating label (3). Scaled so a layer never outranks a whole cell.
 */
export function depthKey(p: WorldPoint, layer = 0): number {
  return (p.x + p.y) * 8 + layer;
}

/**
 * The on-screen ellipse of a WORLD circle of `radius` cells (chunk 08 QA B2). Under the 2:1
 * projection a world circle of radius r maps to an axis-aligned ellipse with semi-axes
 * r·√2·TILE_W/2 and r·√2·TILE_H/2 — the world axes run along the diamond's diagonals, so
 * a cell's own diagonal (√2) is what spans one screen half-width. Drawing r·TILE_W/2 would
 * draw the circle at 1/√2 of its true size.
 */
export function radiusEllipse(radius: number): { readonly rx: number; readonly ry: number } {
  return { rx: radius * Math.SQRT2 * (TILE_W / 2), ry: radius * Math.SQRT2 * (TILE_H / 2) };
}

/** The four screen corners of a cell's diamond, clockwise from the top. */
export function cellDiamond(cell: CellLike): readonly ScreenPoint[] {
  return [
    project({ x: cell.x, y: cell.y }),
    project({ x: cell.x + 1, y: cell.y }),
    project({ x: cell.x + 1, y: cell.y + 1 }),
    project({ x: cell.x, y: cell.y + 1 }),
  ];
}

/** Screen-space bounding box of a rectangle of cells, used to centre and clamp the camera. */
export function latticeBounds(width: number, height: number): { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } {
  const corners = [project({ x: 0, y: 0 }), project({ x: width, y: 0 }), project({ x: width, y: height }), project({ x: 0, y: height })];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Camera: pan and zoom as pure state. The scene applies it as a container transform;
// pointer handlers call these and never touch PixiJS objects directly.
// ─────────────────────────────────────────────────────────────────────────────────────

export interface Camera {
  /** Screen pixel at which world-projected (0,0) lands, in canvas CSS pixels. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly zoom: number;
}

export const ZOOM_MIN = 0.12;
export const ZOOM_MAX = 2.5;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** A camera that fits the whole lattice inside a viewport with a margin. */
export function fitCamera(viewportW: number, viewportH: number, width: number, height: number, margin = 12): Camera {
  const b = latticeBounds(width, height);
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const zoom = clampZoom(Math.min((viewportW - margin * 2) / bw, (viewportH - margin * 2) / bh));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { zoom, offsetX: viewportW / 2 - cx * zoom, offsetY: viewportH / 2 - cy * zoom };
}

/** A rectangle of cells, inclusive of both corners. */
export interface CellRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * A camera that frames `rect` (chunk 08 QA S10: selecting a tray item zooms to the ring so
 * the targets are big enough to tap). Never zooms OUT: if the current camera is already
 * closer than the fit, it only re-centres on the rect.
 */
export function focusCamera(cam: Camera, viewportW: number, viewportH: number, rect: CellRect, margin = 12, minZoom = 0): Camera {
  const corners = [project({ x: rect.x0, y: rect.y0 }), project({ x: rect.x1 + 1, y: rect.y0 }), project({ x: rect.x1 + 1, y: rect.y1 + 1 }), project({ x: rect.x0, y: rect.y1 + 1 })];
  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxY = Math.max(...corners.map((c) => c.y));
  const fit = clampZoom(Math.min((viewportW - margin * 2) / (maxX - minX), (viewportH - margin * 2) / (maxY - minY)));
  const zoom = Math.max(cam.zoom, fit, clampZoom(minZoom));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { zoom, offsetX: viewportW / 2 - cx * zoom, offsetY: viewportH / 2 - cy * zoom };
}

/** Canvas CSS pixel → world point under a camera. */
export function canvasToWorld(cam: Camera, cx: number, cy: number): WorldPoint {
  return unproject({ x: (cx - cam.offsetX) / cam.zoom, y: (cy - cam.offsetY) / cam.zoom });
}

/** World point → canvas CSS pixel under a camera. */
export function worldToCanvas(cam: Camera, p: WorldPoint): ScreenPoint {
  const s = project(p);
  return { x: s.x * cam.zoom + cam.offsetX, y: s.y * cam.zoom + cam.offsetY };
}

export function panCamera(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, offsetX: cam.offsetX + dx, offsetY: cam.offsetY + dy };
}

/** Zoom about a canvas point so the world under the finger (or wheel) stays put. */
export function zoomCameraAbout(cam: Camera, factor: number, cx: number, cy: number): Camera {
  const zoom = clampZoom(cam.zoom * factor);
  const k = zoom / cam.zoom;
  return { zoom, offsetX: cx - (cx - cam.offsetX) * k, offsetY: cy - (cy - cam.offsetY) * k };
}

/**
 * Pinch: two pointers moved from (a0, b0) to (a1, b1). Scales about the midpoint and pans by
 * the midpoint's movement, so the gesture reads as "grab the map with two fingers".
 */
export function pinchCamera(cam: Camera, a0: ScreenPoint, b0: ScreenPoint, a1: ScreenPoint, b1: ScreenPoint): Camera {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  const factor = d0 > 0 ? d1 / d0 : 1;
  const zoomed = zoomCameraAbout(cam, factor, m0.x, m0.y);
  return panCamera(zoomed, m1.x - m0.x, m1.y - m0.y);
}

/** Keep at least `keep` pixels of the lattice inside the viewport so the map cannot be lost. */
export function clampCamera(cam: Camera, viewportW: number, viewportH: number, width: number, height: number, keep = 80): Camera {
  const b = latticeBounds(width, height);
  const minX = b.minX * cam.zoom;
  const maxX = b.maxX * cam.zoom;
  const minY = b.minY * cam.zoom;
  const maxY = b.maxY * cam.zoom;
  let { offsetX, offsetY } = cam;
  if (offsetX + maxX < keep) offsetX = keep - maxX;
  if (offsetX + minX > viewportW - keep) offsetX = viewportW - keep - minX;
  if (offsetY + maxY < keep) offsetY = keep - maxY;
  if (offsetY + minY > viewportH - keep) offsetY = viewportH - keep - minY;
  return { ...cam, offsetX, offsetY };
}
