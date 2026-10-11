/**
 * The React wrapper around IsoScene (chunk 08). Owns the canvas element, the camera and
 * every pointer gesture, and nothing else:
 *   - one pointer on empty ground: PAN;  two pointers: PINCH-ZOOM (wheel zooms on desktop);
 *   - one pointer on a movable entity: ENTITY DRAG, reported through `onDragBegin` /
 *     `onDragMove` / `onDragEnd` as snapped cells — the screen decides what a drop means;
 *   - a short still press: TAP on an entity (`onTapEntity`) or a cell (`onTapCell`), which
 *     is the no-drag way to place: select in the tray, tap a cell. Nothing here needs hover.
 * Drags that START in the DOM (the manifest tray) use the imperative handle to convert
 * client coordinates to world cells; the scene then shows the same ghost and lattice.
 *
 * Pointer events only (mouse, touch and pen alike), `touch-action: none` on the canvas.
 * `prefers-reduced-motion` turns the lattice fade into an instant toggle.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { hitTest } from "./hit.ts";
import {
  canvasToWorld,
  clampCamera,
  fitCamera,
  isOnLattice,
  panCamera,
  pinchCamera,
  snapToCell,
  worldToCanvas,
  zoomCameraAbout,
  type Camera,
  type CellLike,
  type WorldPoint,
} from "./projection.ts";
import { IsoScene, type SceneGeometry } from "./scene.ts";
import type { HitResult, IsoSceneState } from "./types.ts";

export interface IsoCanvasHandle {
  /** Client (viewport) pixel → lattice cell, or null when off the canvas or off the lattice. */
  clientToCell(clientX: number, clientY: number): CellLike | null;
  /** Centre of a cell in client pixels (tests and the e2e aim drops with it). */
  cellToClient(cell: CellLike): { x: number; y: number } | null;
  /** Whether a client point is over the canvas element at all. */
  isOverCanvas(clientX: number, clientY: number): boolean;
  /** Current lattice overlay opacity (0 when nothing is being dragged). */
  latticeAlpha(): number;
}

export interface IsoCanvasProps {
  readonly geometry: SceneGeometry;
  readonly state: IsoSceneState;
  readonly label: string;
  readonly background?: number;
  /** Which entities may be picked up and moved. */
  readonly canDrag?: (hit: HitResult) => boolean;
  readonly onTapCell?: (cell: CellLike) => void;
  readonly onTapEntity?: (hit: HitResult) => void;
  readonly onDragBegin?: (hit: HitResult) => void;
  readonly onDragMove?: (cell: CellLike | null) => void;
  readonly onDragEnd?: (cell: CellLike | null) => void;
  /** Called once if the renderer cannot start (no WebGL); the screen shows its text alternative. */
  readonly onUnavailable?: (reason: string) => void;
}

const TAP_MOVE_PX = 8;
const TAP_MS = 400;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Gesture =
  | { kind: "none" }
  | { kind: "pan"; pointerId: number; lastX: number; lastY: number; startX: number; startY: number; startedAt: number; moved: boolean }
  | { kind: "pinch"; a: number; b: number; ax: number; ay: number; bx: number; by: number }
  | { kind: "drag"; pointerId: number; hit: HitResult; moved: boolean; startX: number; startY: number; startedAt: number };

export const IsoCanvas = forwardRef<IsoCanvasHandle, IsoCanvasProps>(function IsoCanvas(props, ref) {
  const { geometry, state, label, background = 0x1b1a17, canDrag, onTapCell, onTapEntity, onDragBegin, onDragMove, onDragEnd, onUnavailable } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<IsoScene | null>(null);
  const camRef = useRef<Camera>({ offsetX: 0, offsetY: 0, zoom: 1 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const gestureRef = useRef<Gesture>({ kind: "none" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const applyCamera = (cam: Camera): void => {
    const { w, h } = sizeRef.current;
    camRef.current = clampCamera(cam, w, h, geometry.width, geometry.height);
    sceneRef.current?.setCamera(camRef.current);
  };

  const clientToCanvas = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };
  const clientToWorld = (clientX: number, clientY: number): WorldPoint | null => {
    const c = clientToCanvas(clientX, clientY);
    if (!c) return null;
    const { w, h } = sizeRef.current;
    if (c.x < 0 || c.y < 0 || c.x > w || c.y > h) return null;
    return canvasToWorld(camRef.current, c.x, c.y);
  };
  const worldToCell = (p: WorldPoint | null): CellLike | null => (p && isOnLattice(p, geometry.width, geometry.height) ? snapToCell(p) : null);

  const handle: IsoCanvasHandle = {
    clientToCell: (x, y) => worldToCell(clientToWorld(x, y)),
    cellToClient: (cell) => {
      const el = canvasRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = worldToCanvas(camRef.current, { x: cell.x + 0.5, y: cell.y + 0.5 });
      return { x: r.left + s.x, y: r.top + s.y };
    },
    isOverCanvas: (x, y) => {
      const c = clientToCanvas(x, y);
      const { w, h } = sizeRef.current;
      return !!c && c.x >= 0 && c.y >= 0 && c.x <= w && c.y <= h;
    },
    latticeAlpha: () => sceneRef.current?.latticeAlpha ?? 0,
  };
  useImperativeHandle(ref, () => handle);
  // Test hook (the Playwright e2e aims drops with it): the same handle, on `window`. Harmless in production.
  useEffect(() => {
    const w = window as unknown as { __isoDebug?: IsoCanvasHandle };
    w.__isoDebug = handle;
    return () => {
      if (w.__isoDebug === handle) delete w.__isoDebug;
    };
  });

  // Mount the renderer once; size it to the host; fit the camera to the lattice.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const scene = new IsoScene({ geometry, reducedMotion: prefersReducedMotion(), background });
    sceneRef.current = scene;
    let disposed = false;
    const measure = (): { w: number; h: number } => ({ w: Math.max(1, Math.floor(host.clientWidth)), h: Math.max(1, Math.floor(host.clientHeight)) });
    const first = measure();
    sizeRef.current = first;
    camRef.current = fitCamera(first.w, first.h, geometry.width, geometry.height);
    scene
      .mount(canvas, first.w, first.h)
      .then(() => {
        if (disposed) return;
        scene.setCamera(camRef.current);
        scene.update(stateRef.current);
      })
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        setUnavailable(reason);
        onUnavailable?.(reason);
      });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      const next = measure();
      if (next.w === sizeRef.current.w && next.h === sizeRef.current.h) return;
      const prev = sizeRef.current;
      sizeRef.current = next;
      scene.resize(next.w, next.h);
      // Keep the world point at the viewport centre fixed through the resize.
      const cam = camRef.current;
      applyCamera({ ...cam, offsetX: cam.offsetX + (next.w - prev.w) / 2, offsetY: cam.offsetY + (next.h - prev.h) / 2 });
    }) : null;
    ro?.observe(host);
    return () => {
      disposed = true;
      ro?.disconnect();
      scene.destroy();
      sceneRef.current = null;
    };
    // The geometry is fixed per place; remounting on change is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry]);

  useEffect(() => {
    sceneRef.current?.update(state);
  }, [state]);

  // ── pointer gestures ──────────────────────────────────────────────────────────────

  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const c = clientToCanvas(e.clientX, e.clientY);
    if (!c) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, c);
    const g = gestureRef.current;
    if (pointers.current.size === 2 && (g.kind === "pan" || g.kind === "none")) {
      const [[aId, a], [bId, b]] = [...pointers.current.entries()] as [[number, { x: number; y: number }], [number, { x: number; y: number }]];
      gestureRef.current = { kind: "pinch", a: aId, b: bId, ax: a.x, ay: a.y, bx: b.x, by: b.y };
      return;
    }
    if (g.kind !== "none") return;
    const world = canvasToWorld(camRef.current, c.x, c.y);
    const hit = hitTest(stateRef.current, world);
    const now = performance.now();
    if (hit && canDrag?.(hit)) {
      gestureRef.current = { kind: "drag", pointerId: e.pointerId, hit, moved: false, startX: c.x, startY: c.y, startedAt: now };
      return;
    }
    gestureRef.current = { kind: "pan", pointerId: e.pointerId, lastX: c.x, lastY: c.y, startX: c.x, startY: c.y, startedAt: now, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const c = clientToCanvas(e.clientX, e.clientY);
    if (!c) return;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, c);
    const g = gestureRef.current;
    if (g.kind === "pan" && g.pointerId === e.pointerId) {
      const dx = c.x - g.lastX;
      const dy = c.y - g.lastY;
      const moved = g.moved || Math.hypot(c.x - g.startX, c.y - g.startY) > TAP_MOVE_PX;
      gestureRef.current = { ...g, lastX: c.x, lastY: c.y, moved };
      if (moved) applyCamera(panCamera(camRef.current, dx, dy));
    } else if (g.kind === "pinch") {
      const a = pointers.current.get(g.a);
      const b = pointers.current.get(g.b);
      if (!a || !b) return;
      applyCamera(pinchCamera(camRef.current, { x: g.ax, y: g.ay }, { x: g.bx, y: g.by }, a, b));
      gestureRef.current = { ...g, ax: a.x, ay: a.y, bx: b.x, by: b.y };
    } else if (g.kind === "drag" && g.pointerId === e.pointerId) {
      const far = Math.hypot(c.x - g.startX, c.y - g.startY) > TAP_MOVE_PX;
      if (!g.moved && far) {
        gestureRef.current = { ...g, moved: true };
        onDragBegin?.(g.hit);
      }
      if (g.moved || far) onDragMove?.(worldToCell(canvasToWorld(camRef.current, c.x, c.y)));
    }
  };

  const finish = (e: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean): void => {
    const c = clientToCanvas(e.clientX, e.clientY);
    pointers.current.delete(e.pointerId);
    const g = gestureRef.current;
    if (g.kind === "pinch") {
      if (pointers.current.size < 2) gestureRef.current = { kind: "none" };
      return;
    }
    if (g.kind === "pan" && g.pointerId === e.pointerId) {
      gestureRef.current = { kind: "none" };
      if (!cancelled && !g.moved && performance.now() - g.startedAt < TAP_MS && c) {
        const cell = worldToCell(canvasToWorld(camRef.current, c.x, c.y));
        if (cell) onTapCell?.(cell);
      }
      return;
    }
    if (g.kind === "drag" && g.pointerId === e.pointerId) {
      gestureRef.current = { kind: "none" };
      if (g.moved) onDragEnd?.(cancelled || !c ? null : worldToCell(canvasToWorld(camRef.current, c.x, c.y)));
      else if (!cancelled) onTapEntity?.(g.hit);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const c = clientToCanvas(e.clientX, e.clientY);
    if (!c) return;
    applyCamera(zoomCameraAbout(camRef.current, e.deltaY < 0 ? 1.12 : 1 / 1.12, c.x, c.y));
  };

  return (
    <div ref={hostRef} className="iso" data-testid="iso-host">
      <canvas
        ref={canvasRef}
        className="iso__canvas"
        role="img"
        aria-label={label}
        data-testid="iso-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onWheel={onWheel}
      />
      {unavailable && (
        <p className="iso__unavailable hint" role="status">
          {label}: {unavailable}
        </p>
      )}
    </div>
  );
});
