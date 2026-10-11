/**
 * The tick log (chunk 10 starts it; chunk 13 finishes the format and the renderer).
 *
 * Events and waypoints, not per-tick state (chunk 13 LOG_FORMAT): a `path` record says
 * "unit u begins moving along these waypoints at `speed` per tick from tick t"; a renderer
 * interpolates. A `keyframe` every keyframeInterval ticks carries full positions and HP so
 * playback can seek and a truncated log is detectable. Every value is an integer. Keys are
 * short and fixed; the order of events within a tick is the phase order, then unit id.
 *
 * The log is RETURNED inside the output, never written: the resolver has no I/O.
 */
import type { Target } from "./state.js";

export interface LogTarget {
  readonly kind: Target["kind"];
  /** Unit id or trap index; −1 for the core. */
  readonly id: number;
}

export type LogEvent =
  /** Tick zero: where every unit stands. */
  | { readonly t: number; readonly k: "spawn"; readonly u: number; readonly x: number; readonly y: number }
  /** Phase 1: the unit's stance target changed (null = nothing left to target). */
  | { readonly t: number; readonly k: "target"; readonly u: number; readonly target: LogTarget | null }
  /** Phase 2: the unit's remaining route changed. `wp` are [x, y, breachFenceIndex]. */
  | { readonly t: number; readonly k: "path"; readonly u: number; readonly speed: number; readonly wp: readonly (readonly [number, number, number])[] }
  /** Phase 3: the unit stopped (target in range, arrived, or breaching) / resumed. */
  | { readonly t: number; readonly k: "hold"; readonly u: number; readonly holding: boolean }
  /** Phase 3: the unit first stood on a core cell. */
  | { readonly t: number; readonly k: "core_reached"; readonly u: number }
  /** Phase 6: a breach hit on a fence segment. `hp` is the segment's HP after the hit. */
  | { readonly t: number; readonly k: "fence_hit"; readonly u: number; readonly f: number; readonly damage: number; readonly hp: number }
  /** Phase 8: the segment is destroyed and no longer blocks. */
  | { readonly t: number; readonly k: "fence_broken"; readonly f: number }
  /** End of tick, every keyframeInterval ticks and on the final tick. */
  | {
      readonly t: number;
      readonly k: "keyframe";
      readonly units: readonly { readonly u: number; readonly x: number; readonly y: number; readonly hp: number; readonly alive: boolean }[];
      readonly fences: readonly { readonly f: number; readonly hp: number }[];
      readonly traps: readonly { readonly i: number; readonly spent: boolean }[];
    };

export function logTarget(t: Target | null): LogTarget | null {
  if (t === null) return null;
  if (t.kind === "unit") return { kind: "unit", id: t.id };
  if (t.kind === "trap") return { kind: "trap", id: t.index };
  return { kind: "core", id: -1 };
}
