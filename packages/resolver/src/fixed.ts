/**
 * Fixed-point numerics for the resolver (chunk 10; GUARDRAILS §1).
 *
 * THE ONE SCALE: every fractional quantity in the simulation — positions, velocities,
 * distances, radii, multipliers — is an integer in units of 1/FIXED_POINT_SCALE cell.
 * The value matches @caravan/content's FIXED_POINT_SCALE (content authors in the same
 * units); the resolver re-declares it here because it imports nothing. A circle test pins
 * the two equal.
 *
 * ROUNDING MODE: every division in this package is FLOOR TOWARD NEGATIVE INFINITY
 * (`Math.floor(a / b)`), applied consistently, including for negative numerators. Floor is
 * exact for integer operands below 2^52: for |a|, |b| < 2^52 the double quotient can only
 * be rounded across an integer boundary if the true fractional part is below one ulp, and
 * (k / b) ≥ 1 / b > (a / b) · 2^-52 whenever a < 2^52. Every quantity here is far smaller
 * (the largest, a squared distance across the 32-cell field, is ≈ 2.1 × 10⁹).
 *
 * No `sqrt`: distances are compared squared. Where a magnitude is genuinely needed
 * (scaling a step along a direction vector) `isqrt` is a deterministic integer Newton
 * iteration that returns floor(√n) exactly.
 */

/** 1.0 in fixed point: 1/1024 cell resolution. Same value as @caravan/content. */
export const FIXED_POINT_SCALE = 1024;

/** Branded integer: a fixed-point value in 1/FIXED_POINT_SCALE units. Structurally identical to content's brand. */
export type Fixed = number & { readonly __brand: "Fixed" };

/** Branded integer: a duration in whole milliseconds. Structurally identical to content's brand. */
export type Millis = number & { readonly __brand: "Millis" };

/** Exactly 1.0. */
export const FIXED_ONE: Fixed = FIXED_POINT_SCALE as Fixed;

/** Half a cell: the offset from a cell's corner to its centre. */
export const HALF_CELL: Fixed = Math.trunc(FIXED_POINT_SCALE / 2) as Fixed;

/** Whole cells as fixed point. */
export function fp(whole: number): Fixed {
  return (whole * FIXED_POINT_SCALE) as Fixed;
}

/** Floor division (toward −∞). The ONLY division helper the simulation uses. */
export function fpDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Fixed × Fixed → Fixed, floored. */
export function fpMul(a: Fixed, b: Fixed): Fixed {
  return Math.floor((a * b) / FIXED_POINT_SCALE) as Fixed;
}

/** Apply a fixed-point multiplier to a plain integer (damage × mult), floored. */
export function scaleInt(value: number, mult: Fixed): number {
  return Math.floor((value * mult) / FIXED_POINT_SCALE);
}

/**
 * Apply TWO fixed-point multipliers to a plain integer with ONE floor (chunk 12 QA S3: the
 * self buff multiplies the pre-floor merged product): floor(value × a × b / SCALE²), exact
 * for non-negative operands. value × a × b can exceed 2^53 at the input bounds (value ≤
 * 6.4 × 10⁷, a, b ≤ ×65), so it is evaluated as floor((value × ⌊ab/S⌋ + ⌊value × (ab mod S)
 * / S⌋) / S) — the nested-floor identity ⌊(S·A + B) / S²⌋ = ⌊(A + ⌊B / S⌋) / S⌋ — with every
 * intermediate product below 2^53.
 */
export function scaleInt2(value: number, a: Fixed, b: Fixed): number {
  const ab = a * b;
  const q = Math.floor(ab / FIXED_POINT_SCALE);
  const r = ab - q * FIXED_POINT_SCALE;
  return Math.floor((value * q + Math.floor((value * r) / FIXED_POINT_SCALE)) / FIXED_POINT_SCALE);
}

/** Square a fixed-point length so it can be compared with a squared distance. */
export function fixedSq(length: Fixed): number {
  return length * length;
}

/** Ceiling division for non-negative integers: ⌈a / b⌉, b > 0. Used for "hits to destroy". */
export function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/**
 * Integer square root: floor(√n) for n ≥ 0, by Newton's method on integers. Deterministic
 * on every platform because it only uses integer add and floor division. Throws on a
 * negative input rather than returning garbage.
 */
export function isqrt(n: number): number {
  if (n < 0) throw new RangeError(`isqrt of negative ${String(n)}`);
  if (n < 2) return n;
  let x = n;
  let y = Math.floor((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}

/** Clamp an integer to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A sentinel "larger than any cost" that stays a safe integer under addition. */
export const COST_INFINITE = 0x3fffffff;

/**
 * MOVEMENT_LEG (tick.ts), one axis of a leg offset: sign(d) × floor(|d| × progress / len). Floor division on
 * non-negative operands (fixed.ts rounding mode), applied to the magnitude so the result
 * rounds toward the anchor: |offset| < |d| whenever progress < len.
 */
export function legOffset(d: number, progress: number, len: number): number {
  const mag = Math.floor((Math.abs(d) * progress) / len);
  return d < 0 ? -mag : mag;
}
