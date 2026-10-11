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
 *
 * INTERPOLATION CONTRACT (chunk 13's renderer reproduces positions from these events
 * alone; the determinism probe's replica interpolator pins it):
 *   - `path` at tick t: the unit's route becomes `wp`, starting a new LEG from the position
 *     it holds at the start of tick t's movement (= its position after tick t−1). No `path`
 *     event means the route AND the leg in progress are unchanged — a recompute that yields
 *     the same route is silent on purpose.
 *   - Each tick the unit is not holding it advances `speed` along its route: a leg from
 *     anchor A to waypoint W of integer length len = isqrt(|W−A|²) places it at
 *     A + sign(d) × floor(|d| × progress / len) per axis, d = W − A (rounded toward A,
 *     tick.ts `legOffset`); when the leg's remaining length fits the
 *     tick's budget it lands exactly on W, consumes it, and the surplus carries into the
 *     next leg (whose anchor is W). A waypoint with a breach index is not entered while
 *     that fence is intact (`fence_broken` lifts it).
 *   - `hold` is LOAD-BEARING: it is the only record of ticks in which a unit with a route
 *     did not move (engaged in range, breaching, arrived). A renderer that ignores `hold`
 *     and keeps advancing along `wp` will diverge from the authoritative positions, and a
 *     `path` event never re-states a hold. `holding` is edge-triggered: it stays in force
 *     until the next `hold` for that unit.
 *   - `speed` (chunk 11): from the NEXT tick's movement on, the unit advances `speed` per
 *     tick along its CURRENT leg — the leg is not restarted, only the per-tick increment of
 *     `progress` changes (a trap's slow or root, and its expiry). The `path` event's own
 *     `speed` is the value in force when the route was set. `speed` 0 (rooted) is also
 *     reflected by `hold`, which stays authoritative for "did not move".
 *   - Posted units (chunk 11) move too, with the same `path` / `hold` / `speed` events, from
 *     the tick they acquire a target; before that they stand at their spawn position.
 *   - `keyframe` carries authoritative positions for seeking and for detecting a truncated
 *     log; interpolation between keyframes must reproduce them exactly. Since chunk 11 it
 *     also carries each unit's attack cooldown and remaining effect ticks.
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
  /** Phase 3/4 (chunk 11): the unit's per-tick speed changes from the next tick's movement on (slow / root applied or expired). */
  | { readonly t: number; readonly k: "speed"; readonly u: number; readonly speed: number }
  /** Phase 4 (chunk 11): trap `i` fired on unit `u`. `hp` is the unit's HP after; `effect` the status applied, if any. */
  | { readonly t: number; readonly k: "trap_fired"; readonly i: number; readonly u: number; readonly damage: number; readonly hp: number; readonly effect: "slow" | "root" | null }
  /** Phase 4 (chunk 11): trap `i` was crossed by unit `u` but the party's siege counters its category: no effect, still spent. */
  | { readonly t: number; readonly k: "trap_nullified"; readonly i: number; readonly u: number }
  /** Phase 5 (chunk 11): posted unit `u` acquired attacker `v` and begins pursuing. */
  | { readonly t: number; readonly k: "aggro"; readonly u: number; readonly v: number }
  /** Phase 5 (chunk 11): posted unit `u` dropped its pursuit — leash exceeded, target out of aggro, target dead, or no route — and returns to its post. */
  | { readonly t: number; readonly k: "disengage"; readonly u: number; readonly why: "leash" | "lost" | "dead" | "unreachable" }
  /** Phase 5 (chunk 11): posted unit `u` is back on its post and idle. */
  | { readonly t: number; readonly k: "returned"; readonly u: number }
  /** Phase 5 (chunk 11): a `reserve` post saw attacker `v` inside the ring and now behaves as `guard`. */
  | { readonly t: number; readonly k: "released"; readonly u: number; readonly v: number }
  /** Phase 6 (chunk 11): unit `u` hit unit `v` for `damage`; `hp` is v's HP after (0 = dies in phase 8). */
  | { readonly t: number; readonly k: "hit"; readonly u: number; readonly v: number; readonly damage: number; readonly hp: number }
  /** Phase 8 (chunk 11): the unit is dead — out of targeting, out of the fight. */
  | { readonly t: number; readonly k: "unit_died"; readonly u: number }
  /** End of tick, every keyframeInterval ticks and on the final tick. */
  | {
      readonly t: number;
      readonly k: "keyframe";
      readonly units: readonly { readonly u: number; readonly x: number; readonly y: number; readonly hp: number; readonly alive: boolean; readonly cd: number; readonly slow: number; readonly root: number }[];
      readonly fences: readonly { readonly f: number; readonly hp: number }[];
      readonly traps: readonly { readonly i: number; readonly spent: boolean }[];
    };

export function logTarget(t: Target | null): LogTarget | null {
  if (t === null) return null;
  if (t.kind === "unit") return { kind: "unit", id: t.id };
  if (t.kind === "trap") return { kind: "trap", id: t.index };
  return { kind: "core", id: -1 };
}
