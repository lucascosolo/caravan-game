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
 * DEPTH_METRIC (chunk 13; tunable shape, documented for the UI in one sentence):
 *   "How far the deepest raider got: the share of its straight-line distance to the core
 *    that it closed."
 * For every attacker, start = its distance from where it spawned to the core, closest =
 * the smallest distance it was ever at, both measured from its centre to the nearest point
 * of the core block (0 on a core cell) and sampled at the end of every tick it was alive
 * for (including the tick it died on). Its depth is floor(1024 × (start − closest) / start);
 * the fight's depth is the largest over the attackers, an integer 0..1024 (DEPTH_SCALE,
 * fixed-point: 1024 = the core). An overrun is 1024 by construction (the arriving unit's
 * distance is 0). Distances are integers via isqrt (floor √); no float, no sqrt.
 * Fence segments broken and posted units killed are NOT added in: a composite cannot be
 * previewed or explained in a sentence (chunk 13 asks for one), and both already show up
 * as distance — a raider gets deep by breaking through and by outliving the posts.
 *
 * Loot is NOT here. The resolver reports kind and depth; the party OWNER's loot
 * (PARTIAL_LOOT_CURVE: full × depth^1.5 on a wipe, nothing on a stalemate; an overrun pays
 * the trip's Coin transfer + the party win instead) is computed by the server from them and
 * the encounter's Coin value, and credited there or not at all. The resolver never sees Coin.
 */
import { CORE_ORIGIN, CORE_SIZE } from "./battlefield.js";
import { FIXED_POINT_SCALE, isqrt } from "./fixed.js";
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

/** Record this tick's sample for the depth metric. Every attacker that was alive for this tick. */
export function sampleDepth(state: SimState): void {
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive && u.diedTick !== state.tick) continue;
    const d = coreDistSq(u.x, u.y);
    if (d < u.coreClosestSq) u.coreClosestSq = d;
  }
}

/** One attacker's depth, 0..DEPTH_SCALE. */
export function unitDepth(u: UnitState): number {
  const start = isqrt(u.coreStartSq);
  if (start <= 0) return DEPTH_SCALE;
  const closest = isqrt(u.coreClosestSq);
  const closed = start - closest;
  if (closed <= 0) return 0;
  const d = Math.floor((closed * DEPTH_SCALE) / start);
  return d > DEPTH_SCALE ? DEPTH_SCALE : d;
}

/** The fight's depth and who set it. An overrun is always DEPTH_SCALE. */
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
  return { depth, deepestUnit: deepest };
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
