#!/usr/bin/env node
// Resolver dependency-boundary test (chunk 21; GUARDRAILS §1 and §2).
//
// Proves, without running anything from the resolver, that packages/resolver cannot reach
// apps/server, @caravan/content, billing/entitlement code, Node, or the network:
//
//   1. package.json declares zero dependencies / peer / optional dependencies, and its
//      devDependencies are limited to an explicit tooling allowlist. Adding ANY dependency
//      fails this check until a human edits the allowlist here, on purpose.
//   2. tsconfig.json keeps rootDir/include pinned to src, `types: []`, and no paths/references,
//      so a relative import that escapes src is a compile error (TS6059) as well as a lint error.
//   3. Every import / export-from / require / dynamic-import specifier in src is relative and
//      resolves to a file inside packages/resolver/src. No `/// <reference>` directives.
//   4. No specifier anywhere in the package (src, tests, fixtures excluded) names a
//      billing-shaped module or an app.
//   5. eslint.config.js still carries the isolation rules this check relies on at edit time.
//
// Zero dependencies itself; runs with plain Node. Exit code 1 on any finding.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(repoRoot, "packages", "resolver");
const srcDir = path.join(pkgDir, "src");

// Tooling the resolver may use at development time only. Nothing here ships inside the
// resolver or runs during resolution. Extend deliberately; a reviewer should see the diff.
const ALLOWED_DEV_DEPENDENCIES = new Set([
  "@eslint/js",
  "eslint",
  "typescript",
  "typescript-eslint",
  "vitest", // for chunk 13's determinism harness, when it lands
  "@types/node", // only if a harness script outside src needs it; src has `types: []`
]);

// Anything matching these, in any import specifier inside the package, is a boundary breach.
// A word matches as a path segment ("@caravan/content", "../apps/x") or as a file basename
// ("./cosmetics.js"); chunk 20 added cosmetic(s) / pack(s) so the store's modules are
// unreachable by name as well as by location.
const FORBIDDEN_SPECIFIER = /(^|[\\/@])(apps|server|web|content|billing|entitlement|entitlements|purchase|purchases|payment|payments|stripe|store|iap|cosmetic|cosmetics|pack|packs|account|accounts|auth|session|sessions|node_modules|pg|postgres|fastify)([\\/]|\.(?:[cm]?[jt]s|json)$|$)/i;

const findings = [];
const fail = (msg) => findings.push(msg);

// --- 1. package.json --------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) {
  const value = pkg[field];
  if (value && (Array.isArray(value) ? value.length : Object.keys(value).length)) {
    fail(`package.json: '${field}' must be empty, found ${JSON.stringify(value)}. The resolver has zero dependencies.`);
  }
}
for (const name of Object.keys(pkg.devDependencies ?? {})) {
  if (!ALLOWED_DEV_DEPENDENCIES.has(name)) {
    fail(`package.json: devDependency '${name}' is not in the resolver tooling allowlist (scripts/resolver-boundary-check.mjs).`);
  }
}
if (pkg.pnpm || pkg.overrides || pkg.resolutions) fail("package.json: overrides/resolutions are not allowed in the resolver.");

// --- 2. tsconfig.json -------------------------------------------------------------------
const tsconfigRaw = readFileSync(path.join(pkgDir, "tsconfig.json"), "utf8");
const tsconfig = JSON.parse(tsconfigRaw.replace(/^\s*\/\/.*$/gm, ""));
const co = tsconfig.compilerOptions ?? {};
if (co.rootDir !== "src") fail(`tsconfig.json: compilerOptions.rootDir must be "src" (got ${JSON.stringify(co.rootDir)}) so imports escaping src are TS6059 errors.`);
if (!Array.isArray(co.types) || co.types.length !== 0) fail(`tsconfig.json: compilerOptions.types must be [] (got ${JSON.stringify(co.types)}); no @types/node in the resolver.`);
if (co.paths) fail("tsconfig.json: compilerOptions.paths is not allowed in the resolver (it could alias apps/* in).");
if (co.baseUrl) fail("tsconfig.json: compilerOptions.baseUrl is not allowed in the resolver.");
if (co.typeRoots) fail("tsconfig.json: compilerOptions.typeRoots is not allowed in the resolver.");
if (tsconfig.references?.length) fail("tsconfig.json: project references are not allowed in the resolver.");
if (!Array.isArray(tsconfig.include) || tsconfig.include.length !== 1 || tsconfig.include[0] !== "src") {
  fail(`tsconfig.json: include must be exactly ["src"] (got ${JSON.stringify(tsconfig.include)}).`);
}
const libs = (co.lib ?? []).map((l) => l.toLowerCase());
if (libs.some((l) => l === "dom" || l.startsWith("dom.") || l.startsWith("webworker"))) fail(`tsconfig.json: lib must not include DOM/WebWorker (got ${JSON.stringify(co.lib)}).`);

// --- 3 & 4. Walk every TS file and inspect its specifiers ---------------------------------
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "lint-fixtures" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const SPECIFIER_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, // import x from '...'; import '...'
  /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+['"]([^'"]+)['"]/g, // export * from / export {..} from
  /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, // import('...')
  /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, // require('...')
  /\bimport\s*\(\s*(?!['"`])([^)]+)\)/g, // import(expr): flagged below as non-literal
];

if (!existsSync(srcDir)) fail("packages/resolver/src is missing.");
const srcFiles = existsSync(srcDir) ? walk(srcDir) : [];
if (srcFiles.length === 0) fail("packages/resolver/src has no TypeScript files; nothing to check.");

for (const file of walk(pkgDir)) {
  const rel = path.relative(repoRoot, file);
  const inSrc = file.startsWith(srcDir + path.sep);
  const text = readFileSync(file, "utf8");

  if (inSrc && /^\s*\/\/\/\s*<reference\b/m.test(text)) {
    fail(`${rel}: '/// <reference>' directives are banned in resolver src (they can pull in Node/DOM types).`);
  }
  if (inSrc && /\bimport\.meta\b/.test(text)) fail(`${rel}: 'import.meta' is banned in resolver src (environment access).`);
  if (inSrc && /\bprocess\s*\.\s*env\b/.test(text)) fail(`${rel}: 'process.env' is banned in resolver src.`);

  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1].trim();
      if (pattern === SPECIFIER_PATTERNS[4]) {
        if (inSrc) fail(`${rel}: dynamic import with a non-literal specifier: import(${spec}).`);
        continue;
      }
      if (FORBIDDEN_SPECIFIER.test(spec)) fail(`${rel}: specifier '${spec}' names an app or a billing-shaped module.`);
      if (!inSrc) continue; // tests/scripts outside src may use tooling; src may not.
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        fail(`${rel}: non-relative import '${spec}'. The resolver has zero dependencies.`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.startsWith(srcDir + path.sep)) {
        fail(`${rel}: relative import '${spec}' resolves outside packages/resolver/src (${path.relative(repoRoot, resolved)}).`);
      }
    }
  }
}

// --- 5. eslint config still enforces the import boundary ----------------------------------
const eslintConfig = readFileSync(path.join(pkgDir, "eslint.config.js"), "utf8");
for (const needle of ["ImportDeclaration[source.value!=", "ImportExpression", "no-restricted-globals", "FLOAT_LITERAL"]) {
  if (!eslintConfig.includes(needle)) fail(`eslint.config.js: expected isolation rule marker '${needle}' is missing.`);
}

// --- Report -------------------------------------------------------------------------------
if (findings.length) {
  console.error(`Resolver boundary check FAILED (${findings.length} finding${findings.length === 1 ? "" : "s"}):`);
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`Resolver boundary check passed: ${srcFiles.length} src file(s), zero dependencies, all imports internal to packages/resolver/src.`);
