/**
 * The React wrapper around IsoScene (chunk 08). Owns the canvas element, the camera and
 * every pointer gesture, and nothing else. The gesture RULES live in gestures.ts (pure,
 * tested); this file feeds it pointer samples and applies what it says:
 *   - one pointer on empty ground: PAN;  two pointers: PINCH-ZOOM (wheel zooms on desktop);
 *     a second pointer during an entity drag CANCELS the drag and starts the pinch (QA B3);
 *   - one pointer on a movable entity: ENTITY DRAG, reported through `onDragBegin` /
 *     `onDragMove` / `onDragEnd` as snapped cells (`onDragCancel` when a pinch or the
 *     browser takes the pointer) — the screen decides what a drop means;
 *   - a short still press: TAP on an entity (`onTapEntity`) or a cell (`onTapCell`), which
 *     is the no-drag way to place: select in the tray, tap a cell. Nothing here needs hover.
 * Hit testing is in SCREEN pixels with a radius never under 22px (hit.ts, QA S10). Drag
 * moves reach the screen at most once per animation frame (QA S2). The wheel listener is
 * native and non-passive so zooming never also scrolls the page (QA S12). `focus` frames a
 * rectangle of cells (zoom in only) when its key changes — the trail uses it to bring the
 * ring close when a tray item is selected (QA S10).
 * Drags that START in the DOM (the manifest tray) use the imperative handle to convert
 * client coordinates to world cells; the scene then shows the same ghost and lattice.
 *
 * Pointer events only (mouse, touch and pen alike), `touch-action: none` on the canvas.
 * `prefers-reduced-motion` turns the lattice fade into an instant toggle.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { GestureMachine, type GestureEffect } from "./gestures.ts";
import { hitRadiusPx, hitTestScreen } from "./hit.ts";
import {
  TILE_W,
  canvasToWorld,
  clampCamera,
  clampZoom,
  fitCamera,
  focusCamera,
  isOnLattice,
  panCamera,
  pinchCamera,
  project,
  snapToCell,
  worldToCanvas,
  zoomCameraAbout,
  type Camera,
  type CellLike,
  type CellRect,
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
  /** Current lattice overlay opacity (0 when nothing is being dragged or placed). */
  latticeAlpha(): number;
  /** Current camera zoom (probes and the e2e read it). */
  zoom(): number;
  /** Whether PixiJS's own accessibility overlay exists (it must not: the DOM lists are the text alternative, QA N3). */
  pixiAccessibility(): boolean;
  /** Frames the renderer has drawn (QA-22 S9 probe: a canvas that stops updating stops counting). */
  framesDrawn(): number;
  /** Whether the renderer's ticker is running (QA-22 N9: it sleeps while nothing changes). */
  ticking(): boolean;
}

export interface IsoCanvasProps {
  readonly geometry: SceneGeometry;
  readonly state: IsoSceneState;
  readonly label: string;
  readonly background?: number;
  /** Which entities may be picked up and moved. */
  readonly canDrag?: (hit: HitResult) => boolean;
  readonly onTapCell?: (cell: CellLike) => void;
  /** `cell`: the cell under the press (r2 N7), so a screen can treat a near-miss on an entity as a tap on the cell. */
  readonly onTapEntity?: (hit: HitResult, cell?: CellLike | null) => void;
  readonly onDragBegin?: (hit: HitResult) => void;
  readonly onDragMove?: (cell: CellLike | null) => void;
  readonly onDragEnd?: (cell: CellLike | null) => void;
  /** The drag was abandoned (a second finger, a cancelled pointer): nothing moves. Defaults to `onDragEnd(null)`. */
  readonly onDragCancel?: () => void;
  /** Frame these cells (zoom in only) whenever `key` changes to a new non-null value. */
  /** `minCellPx` (r2 N14): a zoom floor, as the opening frame has, so a focused close-up is never too small to read. */
  readonly focus?: { readonly key: string; readonly rect: CellRect; readonly minCellPx?: number } | null;
  /** Called once if the renderer cannot start (no WebGL); the screen shows its text alternative. */
  readonly onUnavailable?: (reason: string) => void;
  /**
   * The opening frame (QA-17 S1): a rectangle of cells the camera opens on, filling the
   * viewport, with a cell never narrower than `minCellPx` on screen. Omitted: the whole
   * lattice fits. Pinch / wheel still zoom out to the whole island either way.
   */
  readonly frame?: FrameRect;
  /**
   * Chunk 22 QA S2: the canvas sits inside a page that must scroll (the replay dialog). A
   * vertical one-finger swipe then scrolls the page (`touch-action: pan-y`); a sideways drag
   * and a pinch still move the camera. Off by default: the trail and the town own every gesture.
   */
  readonly touchScroll?: boolean;
  /** QA-22 N9: let the renderer's ticker sleep while nothing changes (the replay sets it). */
  readonly sleepWhenIdle?: boolean;
}

export interface FrameRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** A cell's on-screen diamond width is never below this at the opening zoom (TOUCH_TARGET_MIN). */
  readonly minCellPx?: number;
}

/** The camera that opens on `frame`: the rectangle's projected bounds centred and fitted, but no cell narrower than `minCellPx`. */
export function frameCamera(viewportW: number, viewportH: number, frame: FrameRect, margin = 12): Camera {
  const corners = [
    project({ x: frame.x, y: frame.y }),
    project({ x: frame.x + frame.w, y: frame.y }),
    project({ x: frame.x + frame.w, y: frame.y + frame.h }),
    project({ x: frame.x, y: frame.y + frame.h }),
  ];
  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxY = Math.max(...corners.map((c) => c.y));
  const fit = Math.min((viewportW - margin * 2) / (maxX - minX), (viewportH - margin * 2) / (maxY - minY));
  const floor = (frame.minCellPx ?? 0) / TILE_W;
  const zoom = clampZoom(Math.max(fit, floor));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { zoom, offsetX: viewportW / 2 - cx * zoom, offsetY: viewportH / 2 - cy * zoom };
}

/**
 * QA N5: `window.__isoDebug` exists only in dev and test builds, and in a build made with
 * VITE_ISO_DEBUG=1 (what `pnpm e2e` builds for Playwright). A production build has none.
 */
export const ISO_DEBUG: boolean = import.meta.env.DEV || import.meta.env.MODE === "test" || import.meta.env.VITE_ISO_DEBUG === "1";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const IsoCanvas = forwardRef<IsoCanvasHandle, IsoCanvasProps>(function IsoCanvas(props, ref) {
  const { geometry, state, label, background = 0x1b1a17, focus, onUnavailable, frame } = props;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<IsoScene | null>(null);
  const camRef = useRef<Camera>({ offsetX: 0, offsetY: 0, zoom: 1 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const machine = useRef(new GestureMachine());
  const stateRef = useRef(state);
  stateRef.current = state;
  // Callbacks are read through a ref so the native listeners never hold a stale closure.
  const propsRef = useRef(props);
  propsRef.current = props;
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
  const canvasToCell = (x: number, y: number): CellLike | null => worldToCell(canvasToWorld(camRef.current, x, y));

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
    zoom: () => camRef.current.zoom,
    pixiAccessibility: () => sceneRef.current?.hasPixiAccessibility ?? false,
    framesDrawn: () => sceneRef.current?.framesDrawn ?? 0,
    ticking: () => sceneRef.current?.ticking ?? false,
  };
  useImperativeHandle(ref, () => handle);
  useEffect(() => {
    if (!ISO_DEBUG) return;
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
    const scene = new IsoScene({ geometry, reducedMotion: prefersReducedMotion(), background, sleepWhenIdle: props.sleepWhenIdle ?? false });
    sceneRef.current = scene;
    let disposed = false;
    const measure = (): { w: number; h: number } => ({ w: Math.max(1, Math.floor(host.clientWidth)), h: Math.max(1, Math.floor(host.clientHeight)) });
    const first = measure();
    sizeRef.current = first;
    const opening = frameRef.current;
    camRef.current = opening
      ? clampCamera(frameCamera(first.w, first.h, opening), first.w, first.h, geometry.width, geometry.height)
      : fitCamera(first.w, first.h, geometry.width, geometry.height);
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
    // QA S12: a NATIVE, non-passive wheel listener, so preventDefault keeps the page still.
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const c = clientToCanvas(e.clientX, e.clientY);
      if (!c) return;
      applyCamera(zoomCameraAbout(camRef.current, e.deltaY < 0 ? 1.12 : 1 / 1.12, c.x, c.y));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // QA-17 N7: follow a change to the reduced-motion setting while mounted.
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const onMotion = (e: MediaQueryListEvent): void => scene.setReducedMotion(e.matches);
    mq?.addEventListener?.("change", onMotion);
    return () => {
      disposed = true;
      mq?.removeEventListener?.("change", onMotion);
      ro?.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      scene.destroy();
      sceneRef.current = null;
    };
    // The geometry is fixed per place; remounting on change is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry]);

  useEffect(() => {
    sceneRef.current?.update(state);
  }, [state]);

  // Frame the requested cells when the focus key changes (zoom in only).
  const focusKey = focus?.key ?? null;
  useEffect(() => {
    if (!focus) return;
    const { w, h } = sizeRef.current;
    if (w <= 1 || h <= 1) return;
    applyCamera(focusCamera(camRef.current, w, h, focus.rect, 12, (focus.minCellPx ?? 0) / TILE_W));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // ── pointer gestures ──────────────────────────────────────────────────────────────

  // QA S2: drag moves are coalesced to one per animation frame.
  const rafRef = useRef<number | null>(null);
  const pendingMove = useRef<{ cell: CellLike | null } | null>(null);
  const flushMove = (): void => {
    rafRef.current = null;
    const m = pendingMove.current;
    pendingMove.current = null;
    if (m) propsRef.current.onDragMove?.(m.cell);
  };
  const queueMove = (cell: CellLike | null): void => {
    pendingMove.current = { cell };
    if (rafRef.current === null) rafRef.current = typeof requestAnimationFrame === "function" ? requestAnimationFrame(flushMove) : (flushMove(), null);
  };
  const dropPendingMove = (): void => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    pendingMove.current = null;
  };

  const apply = (effects: readonly GestureEffect[]): void => {
    const p = propsRef.current;
    for (const fx of effects) {
      switch (fx.kind) {
        case "pan":
          applyCamera(panCamera(camRef.current, fx.dx, fx.dy));
          break;
        case "pinch":
          applyCamera(pinchCamera(camRef.current, fx.a0, fx.b0, fx.a1, fx.b1));
          break;
        case "dragBegin":
          p.onDragBegin?.(fx.hit);
          break;
        case "dragMove":
          queueMove(canvasToCell(fx.at.x, fx.at.y));
          break;
        case "dragEnd":
          dropPendingMove();
          p.onDragEnd?.(canvasToCell(fx.at.x, fx.at.y));
          break;
        case "dragCancel":
          dropPendingMove();
          if (p.onDragCancel) p.onDragCancel();
          else p.onDragEnd?.(null);
          break;
        case "tapCell": {
          const cell = canvasToCell(fx.at.x, fx.at.y);
          if (cell) p.onTapCell?.(cell);
          break;
        }
        case "tapEntity":
          p.onTapEntity?.(fx.hit, canvasToCell(fx.at.x, fx.at.y));
          break;
      }
    }
  };

  const sample = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = clientToCanvas(e.clientX, e.clientY);
    return c ? { id: e.pointerId, x: c.x, y: c.y, t: performance.now() } : null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const s = sample(e);
    if (!s) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const hitAt = (x: number, y: number) => hitTestScreen(stateRef.current, { x, y }, camRef.current, hitRadiusPx(camRef.current.zoom));
    apply(machine.current.down(s, hitAt, (hit) => propsRef.current.canDrag?.(hit) ?? false));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const s = sample(e);
    if (s) apply(machine.current.move(s));
  };
  const finish = (e: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean): void => {
    const s = sample(e) ?? { id: e.pointerId, x: -1, y: -1, t: performance.now() };
    apply(machine.current.up(s, cancelled));
  };

  return (
    <div ref={hostRef} className="iso" data-testid="iso-host">
      <canvas
        ref={canvasRef}
        className={props.touchScroll ? "iso__canvas iso__canvas--scroll" : "iso__canvas"}
        role="img"
        aria-label={label}
        data-testid="iso-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
      />
      {unavailable && (
        <p className="iso__unavailable hint" role="status">
          {label}: {unavailable}
        </p>
      )}
    </div>
  );
});
