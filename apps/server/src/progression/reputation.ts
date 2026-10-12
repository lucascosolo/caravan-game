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

/** The smallest multiplier a delta of the given sign can be scaled by (chunk 04 QA D2). */
export function gapMultiplierFloor(baseSign: 1 | -1): number {
  return baseSign < 0 ? TUNABLES.REPUTATION_GAP_MULT_MIN_LOSS : TUNABLES.REPUTATION_GAP_MULT_MIN;
}

/**
 * The gap multiplier in fixed-point (FIXED_ONE = ×1), for a rating gap `opponent − self`
 * and the sign of the base delta. A win against a stronger opponent (positive gap) scales
 * up; a loss to a weaker one (negative gap) scales up; the mirror cases scale down. A win
 * is clamped to [REPUTATION_GAP_MULT_MIN, REPUTATION_GAP_MULT_MAX], a loss to
 * [REPUTATION_GAP_MULT_MIN_LOSS, REPUTATION_GAP_MULT_MAX]: the loss floor is higher so a
 * rating cannot be tanked on purpose as fast as it can be climbed (chunk 04 QA D2).
 */
export function gapMultiplier(gap: number, baseSign: 1 | -1 | 0): number {
  assertInt("gap", gap);
  if (baseSign === 0) return FIXED_ONE;
  const ramp = idiv(baseSign * gap * FIXED_ONE, TUNABLES.REPUTATION_GAP_DIVISOR);
  return clampInt(FIXED_ONE + ramp, gapMultiplierFloor(baseSign), TUNABLES.REPUTATION_GAP_MULT_MAX);
}

/**
 * `base` scaled by the gap multiplier, truncated toward zero. Sign of the result never
 * flips, and the result is never -0 (`|| 0` normalises it, so a canonical JSON payload
 * and a projection fold see the same integer zero).
 */
export function gapScaledDelta(base: number, selfRating: number, opponentRating: number): number {
  assertInt("base", base);
  assertInt("selfRating", selfRating);
  assertInt("opponentRating", opponentRating);
  const sign: 1 | -1 | 0 = base > 0 ? 1 : base < 0 ? -1 : 0;
  const mult = gapMultiplier(opponentRating - selfRating, sign);
  return idiv(base * mult, FIXED_ONE) || 0;
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

/**
 * Startup assertion (chunk 04 QA N4): every base delta, scaled by the smallest multiplier
 * its sign can see, must still be at least one whole point in magnitude. Otherwise a
 * tuning change could make an encounter silently move nothing. Checked once at module
 * load so a bad registry value fails the server at boot, not in the middle of a fight.
 *
 * The one deliberate zero (final play-test review D6, PROJECT.md §10): a held or withdrawn
 * standing party never lowers its owner's Reputation, so REPUTATION_LOSS_ATTACKER is 0 by
 * design and is asserted to stay 0 rather than listed here.
 */
export const REPUTATION_BASE_DELTAS: readonly number[] = [
  TUNABLES.REPUTATION_WIN_ATTACKER,
  TUNABLES.REPUTATION_CARAVAN_HELD,
  TUNABLES.REPUTATION_CARAVAN_OVERRUN,
];
export function assertReputationTunablesCoherent(): void {
  if ((TUNABLES.REPUTATION_LOSS_ATTACKER as number) !== 0) {
    throw new RangeError(`REPUTATION_LOSS_ATTACKER is fixed at 0 by design (PROJECT.md §10: a standing party's owner risks nothing), got ${String(TUNABLES.REPUTATION_LOSS_ATTACKER)}`);
  }
  if (TUNABLES.REPUTATION_WIN_ATTACKER <= 0) throw new RangeError("REPUTATION_WIN_ATTACKER must be positive: a party's success is the only thing that moves its owner's Reputation");
  for (const base of REPUTATION_BASE_DELTAS) {
    if (!Number.isInteger(base) || base === 0) throw new RangeError(`Reputation base delta must be a non-zero integer, got ${String(base)}`);
    const floor = gapMultiplierFloor(base > 0 ? 1 : -1);
    if (Math.abs(base) * floor < FIXED_ONE) {
      throw new RangeError(`Reputation base delta ${base} × gap multiplier floor ${floor} is below FIXED_ONE (${FIXED_ONE}); it would truncate to 0`);
    }
  }
  for (const [name, v] of [
    ["REPUTATION_GAP_MULT_MIN", TUNABLES.REPUTATION_GAP_MULT_MIN],
    ["REPUTATION_GAP_MULT_MIN_LOSS", TUNABLES.REPUTATION_GAP_MULT_MIN_LOSS],
  ] as const) {
    if (!Number.isInteger(v) || v <= 0 || v > TUNABLES.REPUTATION_GAP_MULT_MAX) {
      throw new RangeError(`${name} must be a positive integer no greater than REPUTATION_GAP_MULT_MAX, got ${String(v)}`);
    }
  }
}
assertReputationTunablesCoherent();
