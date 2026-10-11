// Every construct here is a legitimate fixed-point idiom and must NOT be flagged.
import { RESOLVER_VERSION } from "../src/index.js";
export const SCALE = 1024;
export const half = Math.trunc((3 * SCALE) / 2);
export const floored = Math.floor(7 / 2);
export const orZero = (7 / 2) | 0;
export const hex = 0x1e;
export const clamped = Math.max(0, Math.min(SCALE, 5));
export const absolute = Math.abs(-3);
export const version = RESOLVER_VERSION;
