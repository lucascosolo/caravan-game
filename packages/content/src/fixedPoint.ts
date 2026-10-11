/**
 * Fixed-point numerics for all sim-facing content (GUARDRAILS §1: no floats anywhere in
 * the simulation; AGENTS.md "No floats in the simulation").
 *
 * THE ONE SCALE. Every fractional quantity in content — distances in cells, speeds in
 * cells/second, multipliers, fractions — is an integer in units of 1/FIXED_POINT_SCALE.
 * The resolver (chunk 10) uses the same scale for positions; chunk 07 lists it as
 * `FIXED_POINT_SCALE = 1/1024 cell`. It is defined here, once, and imported everywhere.
 *
 * Durations are a separate, exact unit: integer MILLISECONDS (`Millis`). Seconds-as-
 * fixed-point would truncate (0.4 s = 409.6/1024) and then round again when the resolver
 * converts to ticks; whole milliseconds survive the seconds → ticks conversion exactly for
 * any tick rate that divides 1000. Content never encodes a tick rate — the resolver
 * converts ms → ticks at setup.
 *
 * Ratings (offense, defense), HP and flat trap damage are plain integers: they are
 * abstract points, not fractional quantities, so they take no scale.
 *
 * Nothing here is computed at runtime from a random or clock source; the helpers exist
 * only so values can be AUTHORED as integer numerators (e.g. `fpMilli(1500)` = 1.5) and
 * so no float literal ever appears in a content file.
 */

/** 1.0 in fixed point. Sub-cell resolution of 1/1024 cell; 1/1024 of a multiplier. */
export const FIXED_POINT_SCALE = 1024;

/** Branded integer: a fixed-point value in 1/FIXED_POINT_SCALE units. */
export type Fixed = number & { readonly __brand: "Fixed" };

/** Branded integer: a duration in whole milliseconds. */
export type Millis = number & { readonly __brand: "Millis" };

/** Exactly 1.0 in fixed point. */
export const FIXED_ONE: Fixed = FIXED_POINT_SCALE as Fixed;

/** A whole number of units (cells, seconds-per-cell, ×1.0 multiples) as fixed point. */
export function fp(whole: number): Fixed {
  assertInteger(whole, "fp");
  return (whole * FIXED_POINT_SCALE) as Fixed;
}

/**
 * Author a fractional value as integer thousandths: fpMilli(1500) ≈ 1.5, fpMilli(250) ≈ 0.25.
 * Truncated toward zero to the nearest 1/1024 — the stored integer is the authoritative
 * value; the thousandths are just the authoring convenience.
 */
export function fpMilli(thousandths: number): Fixed {
  assertInteger(thousandths, "fpMilli");
  return Math.trunc((thousandths * FIXED_POINT_SCALE) / 1000) as Fixed;
}

/** Author a fractional value as an exact ratio: fpRatio(5, 3) ≈ 1.666…, truncated to 1/1024. */
export function fpRatio(numerator: number, denominator: number): Fixed {
  assertInteger(numerator, "fpRatio");
  assertInteger(denominator, "fpRatio");
  if (denominator === 0) throw new Error("fpRatio: denominator must be non-zero");
  return Math.trunc((numerator * FIXED_POINT_SCALE) / denominator) as Fixed;
}

/** Fixed × Fixed → Fixed, truncated. (a/S)·(b/S) = (a·b/S)/S. Every argument must be an integer. */
export function fpMul(a: Fixed, b: Fixed): Fixed {
  assertInteger(a, "fpMul");
  assertInteger(b, "fpMul");
  return Math.trunc((a * b) / FIXED_POINT_SCALE) as Fixed;
}

/** Apply a fixed-point multiplier to a plain integer (e.g. damage × affinity), floored. Every argument must be an integer. */
export function scaleInt(value: number, mult: Fixed): number {
  assertInteger(value, "scaleInt");
  assertInteger(mult, "scaleInt");
  return Math.floor((value * mult) / FIXED_POINT_SCALE);
}

/** A duration in whole milliseconds. */
export function ms(milliseconds: number): Millis {
  assertInteger(milliseconds, "ms");
  return milliseconds as Millis;
}

/** Whole seconds as milliseconds — `seconds(14)` reads better than `ms(14000)` for cooldowns. */
export function seconds(wholeSeconds: number): Millis {
  assertInteger(wholeSeconds, "seconds");
  return (wholeSeconds * 1000) as Millis;
}

function assertInteger(n: number, where: string): void {
  if (!Number.isInteger(n)) {
    throw new Error(`${where}: expected an integer, got ${String(n)} — content is fixed-point only`);
  }
}
