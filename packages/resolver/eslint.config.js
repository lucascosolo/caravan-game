// Isolation rules for the deterministic resolver (GUARDRAILS §1, AGENTS.md "Working rules").
// The resolver is pure, fixed-point, dependency-free. These rules make violations a lint
// error rather than a code-review finding. They are deliberately strict; if one blocks a
// legitimate fixed-point construct, extend the rule, do not disable it.
//
// Design of the rule set (chunk 01, hardened in chunk 21 against evasions):
//   - Banned globals are banned as *identifiers*, wherever they appear: as a reference, as a
//     local declaration that would shadow them (`const Math = ...`, `declare const process`),
//     as an alias target (`const m = Math`), in destructuring (`const { random } = Math`) and
//     in type positions (`Map<K, V>`). Only property keys (`obj.Date`, `{ Date: 1 }`) are exempt.
//   - `Math` and `Number` may appear ONLY as the object of a dot-access (`Math.trunc`,
//     `Number.isInteger`); every other use (`Number("0.5")`, `Math["random"]`,
//     `Math[\`random\`]`, `Math?.["ran" + "dom"]`, `const m = Math`) is an error.
//   - Computed member access with a string/template key is banned everywhere, so no object
//     can be used to look up a banned property by name.
//   - No floats: no float literals, no exponent literals, no bare `/`, no `**`, no unary `+`
//     coercion, no parseFloat/Number()/parseInt/JSON, no Float arrays or DataView floats,
//     no Infinity/NaN, no toFixed/toPrecision/toExponential/toLocaleString.
//   - No I/O, clock, RNG, environment, dynamic code, or async: process, Date, performance,
//     console, timers, fetch, crypto, eval, Function, Reflect, Proxy, globalThis/self/global,
//     import.meta, dynamic import, require, `with`, async/await/Promise.
//   - Map/Set/WeakMap/WeakSet/WeakRef are banned outright: their iteration order is
//     insertion order, which is a determinism hazard that lint cannot check without types.
//     Use arrays sorted by id (with an explicit comparator) or integer-keyed plain objects.
//   - Imports: relative only, and never through a segment that names another package
//     (apps, packages, content, server, web, billing, ...). scripts/resolver-boundary-check.mjs
//     additionally resolves every specifier and fails anything that leaves src/.
//
// scripts/lint-selftest.mjs lints lint-fixtures/ and proves every rule here fires.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const FLOAT_LITERAL =
  // 1.5  .5  1.  1e3  1.5e-3  5e-1  1_000.5 — but not hex (0x1E), bigint (1n) or plain integers.
  "Literal[raw=/^(?:[0-9][0-9_]*\\.[0-9_]*|\\.[0-9_]+)(?:[eE][-+]?[0-9]+)?$|^[0-9][0-9_]*[eE][-+]?[0-9]+$/]";

const BANNED_MATH = [
  "random", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
  "asinh", "acosh", "atanh", "exp", "expm1", "pow", "sqrt", "cbrt", "hypot", "log", "log2",
  "log10", "log1p", "fround", "f16round", "PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2",
];

const BANNED_NUMBER = ["parseFloat", "parseInt", "EPSILON", "MAX_VALUE", "MIN_VALUE", "POSITIVE_INFINITY", "NEGATIVE_INFINITY", "NaN"];

// Identifiers banned in every position except as a property key. Grouped only for messages.
const BANNED_IDENTIFIERS = {
  "no I/O, clock, RNG, environment or platform access (GUARDRAILS §1)": [
    "Date", "performance", "process", "console", "fetch", "setTimeout", "setInterval",
    "setImmediate", "clearTimeout", "clearInterval", "clearImmediate", "queueMicrotask",
    "structuredClone", "crypto", "require", "module", "exports", "Buffer", "navigator",
    "window", "document", "self", "global", "globalThis", "frames", "top", "parent",
    "localStorage", "sessionStorage", "XMLHttpRequest", "WebSocket", "Worker",
    "SharedArrayBuffer", "Atomics", "Intl", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
  ],
  "no dynamic code or reflection (an evasion route to every other ban)": [
    "eval", "Function", "Reflect", "Proxy", "WeakRef", "FinalizationRegistry",
  ],
  "no async: resolution is a single synchronous pass with a total order of effects (GUARDRAILS §1)": [
    "Promise",
  ],
  "floats are banned: the resolver is fixed-point integers only (GUARDRAILS §1)": [
    "parseFloat", "parseInt", "isNaN", "isFinite", "Infinity", "NaN", "JSON", "DataView",
    "Float16Array", "Float32Array", "Float64Array",
  ],
  "Map/Set iteration is insertion-ordered, a determinism hazard; use arrays sorted by id with an explicit comparator, or integer-keyed objects": [
    "Map", "Set", "WeakMap", "WeakSet",
  ],
};
const ALL_BANNED = Object.values(BANNED_IDENTIFIERS).flat();

// Where an identifier is just a property *name*, not a binding or reference.
const KEY_POSITIONS =
  ":not(MemberExpression[computed=false] > Identifier.property)" +
  ":not(Property[computed=false] > Identifier.key)" +
  ":not(MethodDefinition[computed=false] > Identifier.key)" +
  ":not(PropertyDefinition[computed=false] > Identifier.key)" +
  ":not(TSPropertySignature[computed=false] > Identifier.key)" +
  ":not(TSMethodSignature[computed=false] > Identifier.key)" +
  ":not(TSEnumMember > Identifier.id)" +
  ":not(ImportSpecifier > Identifier.imported)";

// Path segments that can only mean an import has left the resolver package.
const FOREIGN_SEGMENT =
  "/(^|[\\\\/])(apps|packages|content|server|web|billing|entitlement|entitlements|purchase|purchases|payment|payments|stripe|store|iap|node_modules)([\\\\/]|$)/i";

const bannedIdentifierSelectors = Object.entries(BANNED_IDENTIFIERS).flatMap(([why, names]) =>
  names.map((name) => ({
    selector: `Identifier[name='${name}']${KEY_POSITIONS}`,
    message: `'${name}' is banned in the resolver: ${why}.`,
  })),
);

const isolationRules = {
  // Kept alongside the Identifier rules for its scope-aware messages on plain references.
  "no-restricted-globals": ["error", ...ALL_BANNED.map((name) => ({
    name,
    message: `'${name}' is banned in the resolver (GUARDRAILS §1).`,
  }))],
  "no-restricted-properties": ["error",
    ...BANNED_MATH.map((property) => ({
      object: "Math",
      property,
      message: `Math.${property} is banned in the resolver: not deterministic across platforms or produces floats. Use fixed-point integer arithmetic (GUARDRAILS §1).`,
    })),
    ...BANNED_NUMBER.map((property) => ({
      object: "Number",
      property,
      message: `Number.${property} is banned in the resolver: floats are banned (GUARDRAILS §1).`,
    })),
  ],
  "no-restricted-syntax": ["error",
    // --- Banned identifiers, in every position but a property key ------------------------
    ...bannedIdentifierSelectors,
    {
      selector: `Identifier[name=/^(Math|Number)$/]:not(MemberExpression[computed=false][optional=false] > Identifier.object)${KEY_POSITIONS}`,
      message: "'Math' and 'Number' may only be used as `Math.<fn>` / `Number.<fn>`: no Number(...) coercion, no aliasing, no destructuring, no computed or optional access.",
    },
    {
      selector: "MemberExpression[computed=true][object.name=/^(Math|Number)$/]",
      message: "Computed access on Math/Number (Math[\"random\"], Math[`random`], Math[expr]) is banned in the resolver.",
    },
    {
      selector: "MemberExpression[computed=true] > Literal.property[value=type(string)], MemberExpression[computed=true] > TemplateLiteral.property",
      message: "Computed member access with a string key is banned in the resolver (it can reach any banned property by name). Use dot access.",
    },
    { selector: "MemberExpression[property.name='constructor']", message: "'.constructor' is banned in the resolver (it reaches Function and dynamic code)." },
    // --- No imports from outside the package, no dynamic import, no require ----------------
    {
      selector: "ImportDeclaration[source.value!=/^\\.\\.?\\//]",
      message: "The resolver has zero dependencies: only relative imports within packages/resolver/src are allowed.",
    },
    {
      selector: "ExportAllDeclaration[source.value!=/^\\.\\.?\\//], ExportNamedDeclaration[source][source.value!=/^\\.\\.?\\//]",
      message: "The resolver has zero dependencies: only relative re-exports within packages/resolver/src are allowed.",
    },
    {
      selector: `ImportDeclaration[source.value=${FOREIGN_SEGMENT}], ExportAllDeclaration[source.value=${FOREIGN_SEGMENT}], ExportNamedDeclaration[source.value=${FOREIGN_SEGMENT}]`,
      message: "This relative import leaves packages/resolver (apps/*, packages/content, billing...). The resolver imports nothing from outside its own src/.",
    },
    { selector: "ImportExpression", message: "Dynamic import is banned in the resolver." },
    { selector: "TSImportType", message: "import() types are banned in the resolver: no reference to any outside module, even for types." },
    { selector: "TSExternalModuleReference", message: "`import x = require()` is banned in the resolver." },
    { selector: "CallExpression[callee.name='require']", message: "require() is banned in the resolver." },
    { selector: "MetaProperty", message: "import.meta / new.target are banned in the resolver (environment access)." },
    // --- No ambient declarations: they could re-declare a banned global under the ban ------
    { selector: "VariableDeclaration[declare=true], TSDeclareFunction, TSModuleDeclaration[declare=true], TSModuleDeclaration[kind='global']", message: "Ambient `declare` is banned in the resolver (it can re-introduce banned globals)." },
    // --- No floats: literals, coercion, division, exponentiation, formatting ----------------
    { selector: FLOAT_LITERAL, message: "Float literal: the resolver is fixed-point integers only (GUARDRAILS §1)." },
    {
      selector: "UnaryExpression[operator='+']:not([argument.type='Literal'][argument.value=type(number)])",
      message: "Unary '+' coerces to a float (e.g. +\"0.5\"); banned in the resolver.",
    },
    {
      selector: "BinaryExpression[operator='**'], AssignmentExpression[operator='**=']",
      message: "'**' (pow) is banned in the resolver. Multiply out in fixed-point.",
    },
    {
      // '/' produces a float in JS. Allow it only as the direct argument of Math.trunc or
      // Math.floor. `(a / b) | 0` is NOT accepted: it wraps to int32 silently.
      selector:
        "BinaryExpression[operator='/']:not(" +
        "CallExpression[callee.object.name='Math'][callee.property.name=/^(trunc|floor)$/] > BinaryExpression.arguments[operator='/'])",
      message: "Bare '/' yields a float. Write Math.trunc(a / b) or Math.floor(a / b); `| 0` is not accepted (wraps to int32).",
    },
    { selector: "AssignmentExpression[operator='/=']", message: "'/=' yields a float; use Math.trunc(a / b)." },
    {
      selector: "MemberExpression[property.name=/^(toFixed|toPrecision|toExponential|toLocaleString)$/]",
      message: "Float formatting is banned in the resolver.",
    },
    {
      selector: "MemberExpression[property.name=/^(get|set)Float(16|32|64)$/]",
      message: "DataView float accessors are banned in the resolver.",
    },
    // --- No async, no `with`, no debugger ---------------------------------------------------
    {
      selector: "AwaitExpression, ForOfStatement[await=true], :function[async=true]",
      message: "async/await is banned in the resolver: resolution is one synchronous pass (GUARDRAILS §1).",
    },
    { selector: "WithStatement", message: "'with' is banned in the resolver." },
    { selector: "DebuggerStatement", message: "'debugger' is banned in the resolver." },
    // --- Ordering must be explicit ----------------------------------------------------------
    {
      selector: "CallExpression[callee.property.name=/^(sort|toSorted)$/][arguments.length=0]",
      message: "sort() without a comparator orders by string value; pass an explicit comparator (GUARDRAILS §1 tie-break rule).",
    },
  ],
  "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
};

export default tseslint.config(
  { ignores: ["lint-fixtures/**", "scripts/**", "eslint.config.js", "dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,mts,cts,js,mjs,cjs}"],
    rules: isolationRules,
  },
);

// Exposed for scripts/lint-selftest.mjs so fixtures get exactly the src rule set.
export { isolationRules };
