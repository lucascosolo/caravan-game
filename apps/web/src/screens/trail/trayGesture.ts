/**
 * Dragging from the manifest tray (chunk 08 QA B4), PURE so the rules are testable.
 *
 * The tray chips sit in a scrolling page and carry `touch-action: pan-y`, so on a touch
 * screen a vertical swipe over them is the browser's scroll — it must never become a drop.
 * The rules:
 *   - mouse / pen: a press that travels more than TRAY_MOVE_PX starts a drag (no scrolling
 *     to compete with);
 *   - touch: a drag starts only after a LONG PRESS (TRAY_LONG_PRESS_MS still, within
 *     TRAY_MOVE_PX), or when the finger has travelled sideways (pan-y leaves horizontal
 *     travel to the page, so it is not a scroll) or onto the canvas. A mostly-vertical
 *     move before that is a scroll and the gesture is over: nothing will drop;
 *   - a drop happens only on a pointer-up over the canvas while dragging. A pointercancel
 *     (the browser took the pointer for a scroll) cancels; it never drops.
 */
export const TRAY_LONG_PRESS_MS = 350;
export const TRAY_MOVE_PX = 8;

export type TrayPhase = "pressed" | "dragging" | "scrolling" | "done";
export type TrayAction = "none" | "begin" | "move" | "drop" | "cancel";

export class TrayGesture {
  private phase: TrayPhase = "pressed";

  constructor(
    readonly pointerType: string,
    private readonly x0: number,
    private readonly y0: number,
    private readonly t0: number,
  ) {}

  get state(): TrayPhase {
    return this.phase;
  }

  get dragging(): boolean {
    return this.phase === "dragging";
  }

  /** The long-press timer fired at `t` (the caller cancels it on any move past the slop). */
  longPress(t: number): TrayAction {
    if (this.phase !== "pressed" || this.pointerType !== "touch" || t - this.t0 < TRAY_LONG_PRESS_MS) return "none";
    this.phase = "dragging";
    return "begin";
  }

  move(x: number, y: number, overCanvas: boolean): TrayAction {
    if (this.phase === "dragging") return "move";
    if (this.phase !== "pressed") return "none";
    const dx = x - this.x0;
    const dy = y - this.y0;
    if (Math.hypot(dx, dy) <= TRAY_MOVE_PX) return "none";
    if (this.pointerType !== "touch" || overCanvas || Math.abs(dx) > Math.abs(dy)) {
      this.phase = "dragging";
      return "begin";
    }
    this.phase = "scrolling";
    return "none";
  }

  up(overCanvas: boolean): TrayAction {
    const was = this.phase;
    this.phase = "done";
    if (was !== "dragging") return "none";
    return overCanvas ? "drop" : "cancel";
  }

  cancel(): TrayAction {
    const was = this.phase;
    this.phase = "done";
    return was === "dragging" ? "cancel" : "none";
  }
}
