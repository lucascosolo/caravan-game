/**
 * The canvas gesture machine (chunk 08), PURE so every rule is testable without a DOM:
 * IsoCanvas feeds it pointer samples in canvas pixels and applies the effects it returns.
 *
 *   - one pointer on empty ground → PAN (after TAP_MOVE_PX of travel); a short still press
 *     is a TAP on the cell;
 *   - one pointer on a movable entity → ENTITY DRAG (begins after TAP_MOVE_PX); a short
 *     still press is a TAP on the entity;
 *   - a SECOND pointer, whatever the first one is doing → PINCH. If the first pointer was
 *     dragging an entity, the drag is CANCELLED first (`dragCancel`: the item stays where it
 *     was — a move is only ever applied on a drop), so a pinch can never move or place
 *     anything (chunk 08 QA B3). While a pinch is settling (one finger lifted, one still
 *     down) nothing else starts: the remaining finger neither pans nor taps.
 */
import type { HitResult } from "./types.ts";

export const TAP_MOVE_PX = 8;
export const TAP_MS = 400;

export interface PointerSample {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Milliseconds, monotonic (performance.now). */
  readonly t: number;
}

export type GestureState =
  | { readonly kind: "none" }
  | { readonly kind: "settling" }
  | { readonly kind: "pan"; readonly id: number; readonly lastX: number; readonly lastY: number; readonly startX: number; readonly startY: number; readonly startedAt: number; readonly moved: boolean }
  | { readonly kind: "pinch"; readonly a: number; readonly b: number }
  | { readonly kind: "drag"; readonly id: number; readonly hit: HitResult; readonly moved: boolean; readonly startX: number; readonly startY: number; readonly startedAt: number };

export interface XY {
  readonly x: number;
  readonly y: number;
}

export type GestureEffect =
  | { readonly kind: "pan"; readonly dx: number; readonly dy: number }
  | { readonly kind: "pinch"; readonly a0: XY; readonly b0: XY; readonly a1: XY; readonly b1: XY }
  | { readonly kind: "dragBegin"; readonly hit: HitResult }
  | { readonly kind: "dragMove"; readonly at: XY }
  | { readonly kind: "dragEnd"; readonly at: XY }
  | { readonly kind: "dragCancel" }
  | { readonly kind: "tapCell"; readonly at: XY }
  /** `at`: where the press began (final play-test review r2 N7: a tap next to an entity may mean the cell). */
  | { readonly kind: "tapEntity"; readonly hit: HitResult; readonly at: XY };

export class GestureMachine {
  private readonly pointers = new Map<number, XY>();
  private g: GestureState = { kind: "none" };

  get state(): GestureState {
    return this.g;
  }

  get pointerCount(): number {
    return this.pointers.size;
  }

  /** `hitAt` answers what is under a canvas point; `canDrag` whether that thing may be picked up. */
  down(p: PointerSample, hitAt: (x: number, y: number) => HitResult | null, canDrag: (hit: HitResult) => boolean): GestureEffect[] {
    this.pointers.set(p.id, { x: p.x, y: p.y });
    const g = this.g;
    if (this.pointers.size >= 2) {
      if (g.kind === "pinch") return [];
      const out: GestureEffect[] = [];
      if (g.kind === "drag" && g.moved) out.push({ kind: "dragCancel" });
      const [a, b] = [...this.pointers.keys()] as [number, number];
      this.g = { kind: "pinch", a, b };
      return out;
    }
    if (g.kind !== "none") return [];
    const hit = hitAt(p.x, p.y);
    if (hit && canDrag(hit)) {
      this.g = { kind: "drag", id: p.id, hit, moved: false, startX: p.x, startY: p.y, startedAt: p.t };
      return [];
    }
    this.g = { kind: "pan", id: p.id, lastX: p.x, lastY: p.y, startX: p.x, startY: p.y, startedAt: p.t, moved: false };
    return [];
  }

  move(p: PointerSample): GestureEffect[] {
    const prev = this.pointers.get(p.id);
    if (!prev) return [];
    this.pointers.set(p.id, { x: p.x, y: p.y });
    const g = this.g;
    if (g.kind === "pan" && g.id === p.id) {
      const moved = g.moved || Math.hypot(p.x - g.startX, p.y - g.startY) > TAP_MOVE_PX;
      this.g = { ...g, lastX: p.x, lastY: p.y, moved };
      return moved ? [{ kind: "pan", dx: p.x - g.lastX, dy: p.y - g.lastY }] : [];
    }
    if (g.kind === "pinch" && (p.id === g.a || p.id === g.b)) {
      const a1 = this.pointers.get(g.a);
      const b1 = this.pointers.get(g.b);
      if (!a1 || !b1) return [];
      const a0 = p.id === g.a ? prev : a1;
      const b0 = p.id === g.b ? prev : b1;
      return [{ kind: "pinch", a0, b0, a1, b1 }];
    }
    if (g.kind === "drag" && g.id === p.id) {
      const far = Math.hypot(p.x - g.startX, p.y - g.startY) > TAP_MOVE_PX;
      if (!g.moved && !far) return [];
      const out: GestureEffect[] = [];
      if (!g.moved) {
        this.g = { ...g, moved: true };
        out.push({ kind: "dragBegin", hit: g.hit });
      }
      out.push({ kind: "dragMove", at: { x: p.x, y: p.y } });
      return out;
    }
    return [];
  }

  up(p: PointerSample, cancelled: boolean): GestureEffect[] {
    if (!this.pointers.has(p.id)) return [];
    this.pointers.delete(p.id);
    const g = this.g;
    if (g.kind === "pinch" || g.kind === "settling") {
      this.g = this.pointers.size === 0 ? { kind: "none" } : { kind: "settling" };
      return [];
    }
    if (g.kind === "pan" && g.id === p.id) {
      this.g = { kind: "none" };
      if (!cancelled && !g.moved && p.t - g.startedAt < TAP_MS) return [{ kind: "tapCell", at: { x: p.x, y: p.y } }];
      return [];
    }
    if (g.kind === "drag" && g.id === p.id) {
      this.g = { kind: "none" };
      if (g.moved) return [cancelled ? { kind: "dragCancel" } : { kind: "dragEnd", at: { x: p.x, y: p.y } }];
      return cancelled ? [] : [{ kind: "tapEntity", hit: g.hit, at: { x: g.startX, y: g.startY } }];
    }
    return [];
  }
}
