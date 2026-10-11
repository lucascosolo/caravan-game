/**
 * End conditions and depth (chunk 13).
 *
 * END_CONDITIONS — exactly three, checked at the end of every tick (after phase 8, so a
 * tick's deaths and arrivals have all landed), in this precedence:
 *   1. core_overrun  an attacker REACHED the core this tick (`core_reached` was logged: it
 *                    stood on a core cell after its own movement or after a dash its traps
 *                    did not kill — chunk 12 QA B1). Arrival is the decisive event: it
 *                    counts even if the same unit dies later in that tick (it got there
 *                    first in phase order), and it beats a same-tick wipe.
 *   2. party_wiped   no attacker is alive after phase 8.
 *   3. tick_cap      the loop ran TICK_CAP ticks with neither: the attackers withdraw
 *                    (stalemate — favours the caravan). The cap tick itself is checked for
 *                    1 and 2 first, so an arrival or a wipe on the last tick still counts.
 * The fight stops on the tick the condition is met; nothing after it is simulated.
 *
 * OUTCOME_KIND (the vocabulary the server, chunk 04 and chunk 15 share):
 *   core_overrun → caravan_overrun, party_wiped → caravan_held, tick_cap → stalemate.
 *
 * DEPTH_METRIC (chunk 13, RESOLVER_VERSION 8 — QA-13 D1; tunable shape, one sentence for the UI):
 *   "How far the deepest raider got inside the wagon circle: the share of the distance from
 *    the ring's outer edge to the core that it closed."
 * Distance is the Chebyshev distance from a raider's centre to the core block (0 on a core
 * cell): max(|dx|, |dy|) to the block's nearest edge, integer fixed-point. The ring's outer
 * edge is at exactly RING_SPAN = (PERIMETER_RING_RADIUS − ⌊CORE_SIZE / 2⌋) cells by that
 * measure on all four sides, so "inside the ring line" is `distance < RING_SPAN`. A raider's
 * depth is floor(1024 × (RING_SPAN − closest) / RING_SPAN) where `closest` is the smallest
 * distance it was sampled at; a raider that never crossed the ring line contributes 0. The
 * fight's depth is the largest over the attackers, an integer 0..1024 (DEPTH_SCALE,
 * fixed-point: 1024 = the core). Before v8 depth was counted from the raider's spawn on the
 * field edge, which saturated (reaching the fence was already ≈ 0.77).
 * DEPTH_SAMPLE (QA-13 S2): a raider is sampled only where it STOOD ALIVE — right after its own
 * movement in phase 3 (it is alive to move; an arrival there is logged as `core_reached`), right
 * after a dash its traps left it alive from, at the end of every tick it ends alive, and on its
 * arrival tick. A dash its own traps kill (chunk 12 QA B1: it never reaches the dash end) is
 * sampled at the trap that stopped it, never at the dash end — and never at distance 0, because
 * only an arrival is the core. So depth 1024 ⇔ an arrival ⇔ caravan_overrun; a held fight's
 * depth is always below DEPTH_SCALE (fightDepth also clamps it, defensively).
 * Fence segments broken and posted units killed are NOT added in: a composite cannot be
 * previewed or explained in a sentence (chunk 13 asks for one), and both already show up
 * as distance — a raider gets deep by breaking through and by outliving the posts.
 *
 * Loot is NOT here. The resolver reports kind and depth; the party OWNER's loot
 * (PARTIAL_LOOT_CURVE: full × depth^1.5 on a wipe, nothing on a stalemate; an overrun pays
 * the trip's Coin transfer + the party win instead) is computed by the server from them and
 * the encounter's Coin value, and credited there or not at all. The resolver never sees Coin.
 */
import { CORE_ORIGIN, CORE_SIZE, PERIMETER_RING_RADIUS } from "./battlefield.js";
import { FIXED_POINT_SCALE } from "./fixed.js";
import type { SimState, UnitState } from "./state.js";

/** Why the loop stopped (internal vocabulary). */
export type EndReason = "tick_cap" | "party_wiped" | "core_overrun";

/** The three end conditions as the rest of the game names them. */
export const OUTCOME_KINDS = ["caravan_held", "caravan_overrun", "stalemate"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** 1024 = the deepest raider reached the core. */
export const DEPTH_SCALE = FIXED_POINT_SCALE;

export function outcomeKindOf(end: EndReason): OutcomeKind {
  if (end === "core_overrun") return "caravan_overrun";
  if (end === "party_wiped") return "caravan_held";
  return "stalemate";
}

/** The fight's result, distinguishable by kind and by the tick it ended on. */
export interface ResolveOutcome {
  readonly kind: OutcomeKind;
  readonly end: EndReason;
  /** The tick the end condition was met on (TICK_CAP − 1 for a stalemate). */
  readonly endTick: number;
  /** DEPTH_METRIC, 0..DEPTH_SCALE. */
  readonly depth: number;
  /** The attacker that set the depth (lowest id on a tie), or −1 if none moved closer. */
  readonly deepestUnit: number;
}

const CORE_LO_X = CORE_ORIGIN.x * FIXED_POINT_SCALE;
const CORE_HI_X = (CORE_ORIGIN.x + CORE_SIZE) * FIXED_POINT_SCALE - 1;
const CORE_LO_Y = CORE_ORIGIN.y * FIXED_POINT_SCALE;
const CORE_HI_Y = (CORE_ORIGIN.y + CORE_SIZE) * FIXED_POINT_SCALE - 1;

/** Squared distance from a fixed-point position to the nearest point of the core block (0 on a core cell). */
export function coreDistSq(x: number, y: number): number {
  const dx = x < CORE_LO_X ? CORE_LO_X - x : x > CORE_HI_X ? x - CORE_HI_X : 0;
  const dy = y < CORE_LO_Y ? CORE_LO_Y - y : y > CORE_HI_Y ? y - CORE_HI_Y : 0;
  return dx * dx + dy * dy;
}

/**
 * RING_SPAN: the Chebyshev distance from the core block to the ring's outer edge, fixed-point.
 * With the v1 lattice (core 14..16, ring 11..19) it is 3 cells on every side.
 */
export const RING_SPAN = (PERIMETER_RING_RADIUS - Math.trunc(CORE_SIZE / 2)) * FIXED_POINT_SCALE;

/** Chebyshev distance from a fixed-point position to the core block (0 on a core cell). */
export function coreDistCheb(x: number, y: number): number {
  const dx = x < CORE_LO_X ? CORE_LO_X - x : x > CORE_HI_X ? x - CORE_HI_X : 0;
  const dy = y < CORE_LO_Y ? CORE_LO_Y - y : y > CORE_HI_Y ? y - CORE_HI_Y : 0;
  return dx > dy ? dx : dy;
}

/** One DEPTH_SAMPLE for an attacker at (x, y), where it stood alive (see header). */
export function sampleUnitDepth(u: UnitState, x: number, y: number): void {
  const d = coreDistCheb(x, y);
  if (d < u.coreClosest) u.coreClosest = d;
}

/**
 * A dash its own traps killed (abilities.ts): sampled at the trap that stopped it, one fixed-point
 * unit short of the core at the least — it did not arrive, so it is not the core.
 */
export function sampleStoppedDash(u: UnitState, trapX: number, trapY: number): void {
  const d = coreDistCheb(trapX, trapY);
  const stopped = d > 0 ? d : 1;
  if (stopped < u.coreClosest) u.coreClosest = stopped;
}

/** The end-of-tick DEPTH_SAMPLE (see header): every attacker that ended the tick alive, or reached the core on it. */
export function sampleDepth(state: SimState): void {
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive && u.reachedCoreTick !== state.tick) continue;
    sampleUnitDepth(u, u.x, u.y);
  }
}

/** One attacker's depth, 0..DEPTH_SCALE: the share of RING_SPAN it closed (0 outside the ring line). */
export function unitDepth(u: UnitState): number {
  const closest = u.coreClosest;
  if (closest >= RING_SPAN) return 0;
  const d = Math.floor(((RING_SPAN - closest) * DEPTH_SCALE) / RING_SPAN);
  return d > DEPTH_SCALE ? DEPTH_SCALE : d;
}

/** The fight's depth and who set it. An overrun is always DEPTH_SCALE; any other outcome is below it. */
export function fightDepth(state: SimState, end: EndReason): { depth: number; deepestUnit: number } {
  let depth = 0;
  let deepest = -1;
  for (let id = 0; id < state.attackerCount; id++) {
    const d = unitDepth(state.units[id]!);
    if (d > depth) {
      depth = d;
      deepest = id;
    }
  }
  if (end === "core_overrun") {
    // The arriving unit stood on a core cell: its distance is 0, its depth 1024. Name the lowest-id arrival.
    for (let id = 0; id < state.attackerCount; id++) {
      if (state.units[id]!.reachedCoreTick >= 0) return { depth: DEPTH_SCALE, deepestUnit: id };
    }
  }
  // DEPTH_SAMPLE makes 1024 unreachable without an arrival (which would have ended the fight
  // as an overrun); the clamp keeps "depth 1024 ⇔ overrun" true even if a later change broke that.
  return { depth: depth >= DEPTH_SCALE ? DEPTH_SCALE - 1 : depth, deepestUnit: deepest };
}

/** END_CONDITIONS 1 and 2 for the tick just run (see header). */
export function endConditionFor(state: SimState): "core_overrun" | "party_wiped" | null {
  let anyAlive = false;
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (u.reachedCoreTick === state.tick) return "core_overrun";
    if (u.alive) anyAlive = true;
  }
  return anyAlive ? null : "party_wiped";
}
