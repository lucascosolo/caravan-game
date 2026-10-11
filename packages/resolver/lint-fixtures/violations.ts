// Every statement in this file must be flagged by eslint.config.js. The self-test in
// scripts/lint-selftest.mjs asserts that each line listed in EXPECTED_VIOLATION_LINES errors.
import { readFileSync } from "node:fs"; // L3 external import
export const a = 1.5; // L4 float literal
export const b = 2 / 3; // L5 bare division
export const c = 2 ** 3; // L6 pow
export const d = Math.random(); // L7 RNG
export const e = Math.sin(1); // L8 trig
export const f = Date.now(); // L9 clock
export const g = new Date(); // L10 clock
export const h = Math.sqrt(4); // L11 sqrt
export const i = 1e3; // L12 float literal (exponent)
export const j = parseFloat("1.0"); // L13 float
export const k = (1).toFixed(2); // L14 float formatting
export const l = readFileSync; // (uses L2; no extra expectation)
