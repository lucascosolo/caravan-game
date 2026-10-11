// Isolation rules for the deterministic resolver (GUARDRAILS §1, AGENTS.md "Working rules").
// The resolver is pure, fixed-point, dependency-free. These rules make violations a lint
// error rather than a code-review finding. They are deliberately strict; if one blocks a
// legitimate fixed-point construct, extend the rule, do not disable it.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const FLOAT_LITERAL =
  // 1.5  .5  1.  1e3  1.5e-3  — but not hex (0x1E) or plain integers.
  "Literal[raw=/^(?:[0-9][0-9_]*\\.[0-9_]*|\\.[0-9_]+)(?:[eE][-+]?[0-9]+)?$|^[0-9][0-9_]*[eE][-+]?[0-9]+$/]";

const BANNED_MATH = [
  "random", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
  "asinh", "acosh", "atanh", "exp", "expm1", "pow", "sqrt", "cbrt", "hypot", "log", "log2",
  "log10", "log1p", "fround", "PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2",
];

const BANNED_GLOBALS = [
  "Date", "performance", "process", "console", "fetch", "setTimeout", "setInterval",
  "setImmediate", "clearTimeout", "clearInterval", "queueMicrotask", "crypto", "require",
  "globalThis", "window", "document", "navigator", "localStorage", "sessionStorage",
  "XMLHttpRequest", "WebSocket", "Worker", "SharedArrayBuffer", "Atomics", "Intl",
  "parseFloat", "Float32Array", "Float64Array",
];

export default tseslint.config(
  { ignores: ["lint-fixtures/**", "scripts/**", "eslint.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // --- No I/O, no clock, no RNG, no platform globals -----------------------------
      "no-restricted-globals": ["error", ...BANNED_GLOBALS.map((name) => ({
        name,
        message: `'${name}' is banned in the resolver: no I/O, clock, RNG or platform access (GUARDRAILS §1).`,
      }))],
      "no-restricted-properties": ["error",
        ...BANNED_MATH.map((property) => ({
          object: "Math",
          property,
          message: `Math.${property} is banned in the resolver: not deterministic across platforms or produces floats. Use fixed-point integer arithmetic (GUARDRAILS §1).`,
        })),
        { object: "Number", property: "parseFloat", message: "Floats are banned in the resolver." },
        { object: "Number", property: "EPSILON", message: "Floats are banned in the resolver." },
      ],
      // --- No imports from outside the package, no dynamic import, no require ----------
      "no-restricted-syntax": ["error",
        {
          selector: "ImportDeclaration[source.value!=/^\\.\\.?\\//]",
          message: "The resolver has zero dependencies: only relative imports within packages/resolver are allowed.",
        },
        {
          selector: "ExportAllDeclaration[source.value!=/^\\.\\.?\\//], ExportNamedDeclaration[source][source.value!=/^\\.\\.?\\//]",
          message: "The resolver has zero dependencies: only relative re-exports within packages/resolver are allowed.",
        },
        { selector: "ImportExpression", message: "Dynamic import is banned in the resolver." },
        { selector: "CallExpression[callee.name='require']", message: "require() is banned in the resolver." },
        // --- No floats: literals, division, exponentiation --------------------------------
        { selector: FLOAT_LITERAL, message: "Float literal: the resolver is fixed-point integers only (GUARDRAILS §1)." },
        {
          selector: "BinaryExpression[operator='**'], AssignmentExpression[operator='**=']",
          message: "'**' (pow) is banned in the resolver. Multiply out in fixed-point.",
        },
        {
          // '/' produces a float in JS. Allow it only when the result is immediately truncated
          // to an integer: Math.trunc(a / b), Math.floor(a / b) or (a / b) | 0.
          selector:
            "BinaryExpression[operator='/']:not(" +
            "CallExpression[callee.object.name='Math'][callee.property.name=/^(trunc|floor)$/] > BinaryExpression[operator='/'], " +
            "BinaryExpression[operator='|'] > BinaryExpression[operator='/'])",
          message: "Bare '/' yields a float. Wrap it as Math.trunc(a / b) or Math.floor(a / b) (fixed-point integer division only).",
        },
        { selector: "AssignmentExpression[operator='/=']", message: "'/=' yields a float; use Math.trunc(a / b)." },
        { selector: "MemberExpression[property.name='toFixed'], MemberExpression[property.name='toPrecision']", message: "Float formatting is banned in the resolver." },
        // --- No clock / RNG via `new` --------------------------------------------------
        { selector: "NewExpression[callee.name='Date']", message: "Date is banned in the resolver (no clock)." },
        // --- Iteration order must be total: no Map/Set iteration order dependence hazards
        // (Map/Set are allowed as structures, but insertion-order iteration must be avoided).
        { selector: "ForOfStatement > NewExpression[callee.name=/^(Map|Set)$/]", message: "Iterate sorted arrays, not Map/Set insertion order." },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
