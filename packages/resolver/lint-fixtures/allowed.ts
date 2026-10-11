// Every construct here is a legitimate fixed-point idiom and must NOT be flagged.
import { RESOLVER_VERSION } from "../src/index.js";
export const SCALE = 1024;
export const half = Math.trunc((3 * SCALE) / 2);
export const floored = Math.floor(7 / 2);
export const hex = 0x1e;
export const big = 10n;
export const clamped = Math.max(0, Math.min(SCALE, 5));
export const absolute = Math.abs(-3);
export const sign = Math.sign(-3);
export const isInt = Number.isInteger(5) && Number.isSafeInteger(5);
export const maxSafe = Number.MAX_SAFE_INTEGER;
export const shifted = (SCALE >> 2) + (SCALE << 1) + (SCALE & 0xff) + (SCALE % 3);
export const plusOne = +1;
export const sorted = [3, 1, 2].sort((p, q) => p - q);
export const sortedCopy = [3, 1, 2].toSorted((p, q) => p - q);
export const byId: Record<number, number> = { 1: 2 };
export const stats = { random: 1, Date: 2, constructorName: "x" };
export const readProp = stats.random + stats.Date;
export interface Unit { id: number; random: number; Date: number }
export function tick(units: Unit[], _unused: number): number {
  let total = 0;
  for (const u of units) total += u.id;
  return total;
}
export class Rng { random(): number { return 4; } }
export const version = RESOLVER_VERSION;
