/**
 * Reputation — PURE functions. A rating, never a currency: nothing in this module (or
 * anywhere else) exposes a debit-as-cost. The only thing that moves Reputation is an
 * encounter outcome, through `reputationDelta`.
 *
 * Integer-only. The Elo-ish gap scaling is a clamped linear ramp, not 10^(gap/400): no
 * `pow`, no `exp`, no float, so the same two ratings and outcome give the same delta on
 * every platform forever (GUARDRAILS §1). A test asserts purity and integrality over a
 * wide sweep of inputs.
 */
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import type { EncounterOutcomeKind, Side } from "./ladder.js";

function assertInt(name: string, v: number): void {
  if (!Number.isInteger(v)) throw new RangeError(`${name} must be an integer, got ${String(v)}`);
}

/** Truncating integer division (toward zero), inputs and output all integers. */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Base (unscaled) Reputation change for a side and outcome. Pure table lookup. */
export function reputationBaseDelta(side: Side, outcome: EncounterOutcomeKind): number {
  switch (outcome) {
    case "caravan_held":
      return side === "caravan" ? TUNABLES.REPUTATION_CARAVAN_HELD : TUNABLES.REPUTATION_LOSS_ATTACKER;
    case "stalemate":
      // The attackers withdrew: a win for the caravan, a loss for the party (chunk 13 STALEMATE_REPUTATION).
      return side === "caravan" ? TUNABLES.REPUTATION_CARAVAN_HELD : TUNABLES.REPUTATION_LOSS_ATTACKER;
    case "caravan_overrun":
      return side === "caravan" ? TUNABLES.REPUTATION_CARAVAN_OVERRUN : TUNABLES.REPUTATION_WIN_ATTACKER;
  }
}

/**
 * The gap multiplier in fixed-point (FIXED_ONE = ×1), for a rating gap `opponent − self`
 * and the sign of the base delta. A win against a stronger opponent (positive gap) scales
 * up; a loss to a weaker one (negative gap) scales up; the mirror cases scale down. Clamped
 * to [REPUTATION_GAP_MULT_MIN, REPUTATION_GAP_MULT_MAX].
 */
export function gapMultiplier(gap: number, baseSign: 1 | -1 | 0): number {
  assertInt("gap", gap);
  if (baseSign === 0) return FIXED_ONE;
  const ramp = idiv(baseSign * gap * FIXED_ONE, TUNABLES.REPUTATION_GAP_DIVISOR);
  return clampInt(FIXED_ONE + ramp, TUNABLES.REPUTATION_GAP_MULT_MIN, TUNABLES.REPUTATION_GAP_MULT_MAX);
}

/** `base` scaled by the gap multiplier, truncated toward zero. Sign of the result never flips. */
export function gapScaledDelta(base: number, selfRating: number, opponentRating: number): number {
  assertInt("base", base);
  assertInt("selfRating", selfRating);
  assertInt("opponentRating", opponentRating);
  const sign: 1 | -1 | 0 = base > 0 ? 1 : base < 0 ? -1 : 0;
  const mult = gapMultiplier(opponentRating - selfRating, sign);
  return idiv(base * mult, FIXED_ONE);
}

export interface ReputationChange {
  /** The delta before the floor was applied. */
  unclamped: number;
  /** The delta actually applied (what the ledger event carries). */
  delta: number;
  after: number;
  /** True when the floor cut a loss short. */
  floored: boolean;
}

/**
 * Apply the floor: a rating never ends below REPUTATION_FLOOR because of a loss. A rating
 * already at or below the floor (only possible if the floor were raised by tuning) loses
 * nothing further. Gains are never clamped.
 */
export function applyFloor(selfRating: number, unclamped: number): ReputationChange {
  assertInt("selfRating", selfRating);
  assertInt("unclamped", unclamped);
  const floor = TUNABLES.REPUTATION_FLOOR;
  let delta = unclamped;
  if (unclamped < 0) {
    const room = selfRating - floor; // how far this rating may still fall
    const allowed = room > 0 ? -room : 0;
    if (delta < allowed) delta = allowed;
  }
  return { unclamped, delta, after: selfRating + delta, floored: delta !== unclamped };
}

/**
 * THE Reputation function: (side, outcome, my rating, their rating) → change. Pure and
 * deterministic; same inputs → same delta, every time (tested by replay and by sweep).
 */
export function reputationDelta(
  side: Side,
  outcome: EncounterOutcomeKind,
  selfRating: number,
  opponentRating: number,
): ReputationChange {
  const base = reputationBaseDelta(side, outcome);
  return applyFloor(selfRating, gapScaledDelta(base, selfRating, opponentRating));
}
