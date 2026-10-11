/**
 * Ladders — PURE functions. No I/O, no clock, no randomness. Every number comes from the
 * tunables registry.
 *
 * A ladder is (level, points). Points are CUMULATIVE and only ever grow; the level is the
 * highest rung whose threshold the points have reached. Because both inputs are monotone
 * and the fold is monotone, a level can never go down by construction — there is no
 * "subtract" anywhere in this file, and a test asserts the property across every outcome
 * sequence. Rung crossings are reported so the caller can grant that rung's unlock points
 * exactly once: a rung is crossed on the single event that first reaches it, and since
 * levels never fall, it can never be crossed again.
 */
import { TUNABLES } from "@caravan/content";
import type { Pool } from "../db/types.js";

export type EncounterOutcomeKind = "caravan_held" | "caravan_overrun" | "stalemate";
export type Side = "caravan" | "party";

export interface LadderState {
  level: number;
  points: number;
}

export interface LadderAdvance {
  before: LadderState;
  after: LadderState;
  /** Points added by this advance (0 when the ladder is capped). */
  pointsDelta: number;
  /** Rungs newly reached, ascending. Each is reached exactly once in a ladder's life. */
  rungsCrossed: number[];
  /** Unlock points owed for those rungs, in the same order. */
  unlockPointsPerRung: number[];
}

export const LADDER_CAP: number = TUNABLES.LADDER_RUNGS_PER_POOL;

function assertNonNegInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${String(v)}`);
}

/** Cumulative points required to stand on rung n (0 for rung 0). Throws outside 0..cap. */
export function pointsToRung(rung: number): number {
  assertNonNegInt("rung", rung);
  if (rung > LADDER_CAP) throw new RangeError(`rung ${rung} is above the ladder cap ${LADDER_CAP}`);
  return TUNABLES.LADDER_POINTS_TO_RUNG[rung]!;
}

/** Unlock points granted on first reaching rung n. Throws outside 1..cap. */
export function unlockPointsForRung(rung: number): number {
  assertNonNegInt("rung", rung);
  if (rung < 1 || rung > LADDER_CAP) throw new RangeError(`rung ${rung} grants nothing (1..${LADDER_CAP})`);
  return TUNABLES.UNLOCK_POINTS_BY_RUNG[rung]!;
}

/** Sum of grants from rung 1 to the cap — what a maxed ladder has paid out in total. */
export function totalUnlockPointsAtCap(): number {
  let total = 0;
  for (let r = 1; r <= LADDER_CAP; r++) total += unlockPointsForRung(r);
  return total;
}

/**
 * Which pools earn ladder progress on which side (PROJECT.md §5: "levels rise only through
 * use"; chunk 04 brief: traps and living units earn on the active side, siege earns when
 * your standing party fights). A standing party is a template, never an expedition: its
 * living units are not "deployed" by their owner, so the passive side earns no living
 * ladder — the active side is the living pool's path, by design.
 */
export const LADDER_EARNING_POOLS: Readonly<Record<Side, readonly Pool[]>> = {
  caravan: ["living", "trap"],
  party: ["siege"],
};

/**
 * Ladder points a side earns for one encounter, per pool it used. Pure table lookup.
 *   caravan_held    : the party was wiped — caravan prevails, party loses
 *   stalemate       : the party withdrew — counts as the caravan prevailing, a loss for the party
 *   caravan_overrun : an attacker reached the core — party wins, caravan loses (still earns)
 */
export function ladderGainFor(side: Side, outcome: EncounterOutcomeKind): number {
  switch (outcome) {
    case "caravan_held":
      return side === "caravan" ? TUNABLES.LADDER_GAIN_DEFENSE_HELD : TUNABLES.LADDER_GAIN_LOSS;
    case "stalemate":
      return side === "caravan" ? TUNABLES.LADDER_GAIN_DEFENSE_HELD : TUNABLES.LADDER_GAIN_STALEMATE;
    case "caravan_overrun":
      return side === "caravan" ? TUNABLES.LADDER_GAIN_LOSS : TUNABLES.LADDER_GAIN_WIN;
  }
}

/** The level a cumulative points total stands on. Monotone non-decreasing in `points`. */
export function levelForPoints(points: number): number {
  assertNonNegInt("points", points);
  let level = 0;
  while (level < LADDER_CAP && points >= pointsToRung(level + 1)) level++;
  return level;
}

/**
 * Advance a ladder by `gain` points. The returned level is max(before.level, level implied
 * by the new points) — never lower than before even if the stored level is somehow ahead
 * of its points (it cannot be, but the function does not rely on that). A capped ladder
 * absorbs nothing: pointsDelta 0, no crossings, so no event is owed for it.
 */
export function advanceLadder(before: LadderState, gain: number): LadderAdvance {
  assertNonNegInt("level", before.level);
  assertNonNegInt("points", before.points);
  assertNonNegInt("gain", gain);
  if (before.level >= LADDER_CAP) {
    return { before, after: { ...before }, pointsDelta: 0, rungsCrossed: [], unlockPointsPerRung: [] };
  }
  const points = before.points + gain;
  const level = Math.max(before.level, levelForPoints(points));
  const rungsCrossed: number[] = [];
  for (let r = before.level + 1; r <= level; r++) rungsCrossed.push(r);
  return {
    before,
    after: { level, points },
    pointsDelta: gain,
    rungsCrossed,
    unlockPointsPerRung: rungsCrossed.map(unlockPointsForRung),
  };
}
