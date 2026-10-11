import { describe, expect, it } from "vitest";
import { TrayGesture, TRAY_LONG_PRESS_MS } from "../screens/trail/trayGesture.ts";
import { GestureMachine, type GestureEffect } from "./gestures.ts";
import { MIN_HIT_RADIUS_PX, hitRadiusPx, hitTestScreen } from "./hit.ts";
import { TILE_H, TILE_W, focusCamera, project, radiusEllipse, worldToCanvas, type Camera } from "./projection.ts";
import { EMPTY_SCENE, type HitResult } from "./types.ts";

const post: HitResult = { kind: "post", id: "u-rider" };
const onPost = () => post;
const always = () => true;
const kinds = (fx: readonly GestureEffect[]) => fx.map((e) => e.kind);

describe("gesture machine (chunk 08 QA B3)", () => {
  it("a pinch whose first finger lands on a post cancels that drag and zooms; nothing is moved or placed", () => {
    const g = new GestureMachine();
    expect(g.down({ id: 1, x: 100, y: 100, t: 0 }, onPost, always)).toEqual([]);
    // The first finger travels a little before the second lands: the drag has begun.
    expect(kinds(g.move({ id: 1, x: 112, y: 100, t: 10 }))).toEqual(["dragBegin", "dragMove"]);
    expect(kinds(g.down({ id: 2, x: 200, y: 160, t: 20 }, onPost, always))).toEqual(["dragCancel"]);
    expect(g.state.kind).toBe("pinch");
    const all: GestureEffect[] = [];
    for (let i = 1; i <= 8; i++) {
      all.push(...g.move({ id: 1, x: 112 - i * 6, y: 100 - i * 4, t: 20 + i }));
      all.push(...g.move({ id: 2, x: 200 + i * 6, y: 160 + i * 4, t: 20 + i }));
    }
    expect(new Set(kinds(all))).toEqual(new Set(["pinch"]));
    // Lifting one finger, then moving and lifting the other, neither pans, taps nor drops.
    expect(g.up({ id: 1, x: 60, y: 70, t: 40 }, false)).toEqual([]);
    expect(g.state.kind).toBe("settling");
    expect(g.move({ id: 2, x: 300, y: 300, t: 41 })).toEqual([]);
    expect(g.up({ id: 2, x: 300, y: 300, t: 42 }, false)).toEqual([]);
    expect(g.state.kind).toBe("none");
  });

  it("a second finger before the drag began just pinches (no cancel needed)", () => {
    const g = new GestureMachine();
    g.down({ id: 1, x: 100, y: 100, t: 0 }, onPost, always);
    expect(g.down({ id: 2, x: 150, y: 100, t: 5 }, onPost, always)).toEqual([]);
    expect(g.state.kind).toBe("pinch");
  });

  it("a still short press is a tap; a drag ends in a drop; a cancelled pointer never drops", () => {
    const tap = new GestureMachine();
    tap.down({ id: 1, x: 10, y: 10, t: 0 }, () => null, always);
    expect(kinds(tap.up({ id: 1, x: 11, y: 10, t: 100 }, false))).toEqual(["tapCell"]);
    const tapEntity = new GestureMachine();
    tapEntity.down({ id: 1, x: 10, y: 10, t: 0 }, onPost, always);
    expect(tapEntity.up({ id: 1, x: 10, y: 10, t: 100 }, false)).toEqual([{ kind: "tapEntity", hit: post }]);
    const drag = new GestureMachine();
    drag.down({ id: 1, x: 10, y: 10, t: 0 }, onPost, always);
    drag.move({ id: 1, x: 40, y: 10, t: 10 });
    expect(kinds(drag.up({ id: 1, x: 40, y: 10, t: 20 }, false))).toEqual(["dragEnd"]);
    const cancelled = new GestureMachine();
    cancelled.down({ id: 1, x: 10, y: 10, t: 0 }, onPost, always);
    cancelled.move({ id: 1, x: 40, y: 10, t: 10 });
    expect(kinds(cancelled.up({ id: 1, x: 40, y: 10, t: 20 }, true))).toEqual(["dragCancel"]);
    const pan = new GestureMachine();
    pan.down({ id: 1, x: 10, y: 10, t: 0 }, () => null, always);
    expect(kinds(pan.move({ id: 1, x: 40, y: 10, t: 10 }))).toEqual(["pan"]);
    expect(pan.up({ id: 1, x: 40, y: 10, t: 20 }, false)).toEqual([]);
  });
});

describe("tray gesture (chunk 08 QA B4)", () => {
  it("touch: a vertical swipe is a scroll and never drops; a long press or a sideways move starts a drag", () => {
    const swipe = new TrayGesture("touch", 50, 400, 0);
    expect(swipe.move(50, 380, false)).toBe("none");
    expect(swipe.state).toBe("scrolling");
    expect(swipe.move(50, 40, true)).toBe("none");
    expect(swipe.up(true)).toBe("none");
    const hold = new TrayGesture("touch", 50, 400, 0);
    expect(hold.longPress(TRAY_LONG_PRESS_MS - 1)).toBe("none");
    expect(hold.longPress(TRAY_LONG_PRESS_MS)).toBe("begin");
    expect(hold.move(50, 60, true)).toBe("move");
    expect(hold.up(true)).toBe("drop");
    const sideways = new TrayGesture("touch", 50, 400, 0);
    expect(sideways.move(80, 405, false)).toBe("begin");
    expect(sideways.up(false)).toBe("cancel");
    const cancelled = new TrayGesture("touch", 50, 400, 0);
    cancelled.longPress(TRAY_LONG_PRESS_MS);
    expect(cancelled.cancel()).toBe("cancel");
  });

  it("mouse: a move past the slop starts a drag; a lift off the canvas cancels", () => {
    const m = new TrayGesture("mouse", 0, 0, 0);
    expect(m.longPress(10_000)).toBe("none");
    expect(m.move(0, -20, false)).toBe("begin");
    expect(m.up(false)).toBe("cancel");
  });
});

describe("true radii (chunk 08 QA B2)", () => {
  it("the drawn ellipse is the projected image of the world circle", () => {
    for (const r of [0.5, 1.35, 5, 6.35]) {
      const { rx, ry } = radiusEllipse(r);
      const c = project({ x: 15.5, y: 15.5 });
      for (let k = 0; k < 360; k += 15) {
        const th = (k * Math.PI) / 180;
        const p = project({ x: 15.5 + r * Math.cos(th), y: 15.5 + r * Math.sin(th) });
        const n = ((p.x - c.x) / rx) ** 2 + ((p.y - c.y) / ry) ** 2;
        expect(n).toBeCloseTo(1, 9);
      }
      expect(rx).toBeCloseTo(r * Math.SQRT2 * (TILE_W / 2), 9);
      expect(ry).toBeCloseTo(r * Math.SQRT2 * (TILE_H / 2), 9);
    }
  });
});

describe("screen-space hit radius (chunk 08 QA S10)", () => {
  const cam: Camera = { offsetX: 180, offsetY: 20, zoom: 0.3 };
  const state = { ...EMPTY_SCENE, posts: [{ id: "p", pos: { x: 15.5, y: 15.5 }, typeId: "t", mergeLevel: 1, stance: "guard" as const, hpFraction: 1, aggroRadius: 1, leashDistance: 1, attackRange: 1 }] };
  it("is a circle of at least 22px on the glass in every direction, at any zoom", () => {
    expect(hitRadiusPx(0.1)).toBe(MIN_HIT_RADIUS_PX);
    const c = worldToCanvas(cam, { x: 15.5, y: 15.5 });
    for (const [dx, dy] of [[21, 0], [0, 21], [-15, 15], [0, -21]] as const) {
      expect(hitTestScreen(state, { x: c.x + dx, y: c.y + dy }, cam, hitRadiusPx(cam.zoom))).toEqual({ kind: "post", id: "p" });
    }
    expect(hitTestScreen(state, { x: c.x, y: c.y + 23 }, cam, hitRadiusPx(cam.zoom))).toBeNull();
  });

  it("focusCamera frames a rectangle and never zooms out", () => {
    const fit = focusCamera({ offsetX: 0, offsetY: 0, zoom: 0.2 }, 360, 300, { x0: 7, y0: 7, x1: 24, y1: 24 });
    expect(fit.zoom).toBeGreaterThan(0.2);
    const tl = worldToCanvas(fit, { x: 7, y: 7 });
    const br = worldToCanvas(fit, { x: 25, y: 25 });
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.y).toBeLessThanOrEqual(300);
    expect(focusCamera({ offsetX: 0, offsetY: 0, zoom: 2.5 }, 360, 300, { x0: 7, y0: 7, x1: 24, y1: 24 }).zoom).toBe(2.5);
  });
});
