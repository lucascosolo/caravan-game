// Every line from 3 onward must be flagged by eslint.config.js; scripts/lint-selftest.mjs
// asserts each one errors. One evasion per line; a comment names the rule it probes.
import { readFileSync } from "node:fs"; // external import
import { x } from "../../content/src/index.js"; // relative import escaping the package (QA 01 #4)
export * from "../../../apps/server/src/app.js"; // relative re-export escaping the package
export const a = 1.5; // float literal
export const a2 = .5; // float literal, leading dot
export const a3 = 5e-1; // exponent literal
export const b = 2 / 3; // bare division
export const b2 = (7 / 2) | 0; // `| 0` wraps to int32; no longer exempt (QA 01 #6)
export const c = 2 ** 3; // pow operator
export const d = Math.random(); // RNG
export const e = Math.sin(1); // trig
export const f = Date.now(); // clock
export const g = new Date(); // clock
export const h = Math.sqrt(4); // sqrt
export const i = 1e3; // exponent literal
export const j = parseFloat("1.0"); // float
export const k = (1).toFixed(2); // float formatting
export const k2 = (1).toExponential(); // float formatting
export const n1 = Number("0.5"); // Number() coercion (QA 01 #5)
export const n2 = +"0.5"; // unary plus coercion (QA 01 #5)
export const n3 = JSON.parse("0.5"); // JSON (QA 01 #5)
export const m = Math; // aliasing Math (QA 01 #5): the alias site is the error; `m.random()` later cannot exist without it
export const n5 = Math["ran" + "dom"](); // computed access on Math (QA 01 #5)
export const n6 = Math[`random`](); // template computed access
export const n7 = eval("1"); // eval (QA 01 #5)
export const n8 = new Function("return 1"); // Function constructor (QA 01 #5)
export const n9 = new DataView(new ArrayBuffer(8)).getFloat32(0); // DataView float (QA 01 #5)
export const n10 = Infinity; // Infinity (QA 01 #5)
export const n11 = NaN; // NaN (QA 01 #5)
export const n12 = new WeakRef({}); // WeakRef (QA 01 #5)
export const n13 = new Map<number, number>(); // Map banned outright (QA 01 #7)
export const n14 = new Set<number>(); // Set banned outright (QA 01 #7)
export type N15 = Map<number, number>; // Map in a type position
export const n16 = globalThis; // globalThis
export const n17 = Number.EPSILON; // Number.EPSILON
export const n18 = Number.parseFloat("1"); // Number.parseFloat
export const n19 = parseInt("1"); // parseInt
export const n20 = Float64Array; // float typed array
export const n21 = Math.pow(2, 2); // pow
export const n22 = Reflect.get(Math, "trunc"); // Reflect
export const n23 = Math.constructor; // .constructor reaches Function
export const { trunc } = Math; // destructuring Math
export const n24 = Math?.trunc(1); // optional access on Math
export const n25 = ({} as { random: number })["random"]; // string-keyed computed access
export const n26 = process.env["X"]; // environment
export const n27 = console.log; // I/O
export const n28 = setTimeout; // timer
export const n29 = require("fs"); // require
export const n30 = import("./allowed.js"); // dynamic import
export const n31 = import.meta; // import.meta
export async function n32() {} // async function
export const n33 = Promise; // Promise
export const n34 = [3, 1, 2].sort(); // sort without comparator
export const n35 = (1).toPrecision(2); // float formatting
export const n36 = [1, 2].toSorted(); // toSorted without comparator
export const n37 = performance; // clock
export const n38 = crypto; // RNG source
export const n39 = Math.PI; // float constant
export const n40 = Number.MAX_VALUE; // float constant
export const n41 = isNaN(1); // NaN check implies floats
export const n42 = new WeakMap(); // WeakMap
export const n43 = Intl; // locale-dependent
export let n44 = 1; n44 /= 2; // divide-assign
export let n45 = 2; n45 **= 2; // pow-assign
export const n46 = (() => { const Date = 1; return Date; })(); // shadowing a banned global
export type N47 = import("./allowed.js").SCALE; // import() type
