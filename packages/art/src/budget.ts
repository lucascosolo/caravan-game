/**
 * The payload budget (PHASE-2 §26): the town's first load under 8 MB; the battle under 4 MB more.
 *
 * Town = index.html, everything it references, the JS chunks those statically import, the images
 * and fonts the JS names, and everything the CSS loads through url(...) / @import (the UI kit's
 * 9-slices, the OFL fonts), plus the town atlas at the 3x WebP worst case. Battle = every other JS
 * chunk (lazy), the CSS, images and fonts those pull in that the town did not already count, plus
 * the battle atlas. Each file counts once, at its built size; source maps never count.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Finding } from "./coverage.ts";

export const TOWN_LIMIT_BYTES = 8_000_000;
export const BATTLE_LIMIT_BYTES = 4_000_000;

export interface BudgetReport {
  townBytes: number;
  battleBytes: number;
  findings: Finding[];
}

const BINARY_EXT = "png|webp|jpe?g|gif|avif|svg|ttf|otf|woff2?";

/** `ref`, written in `fromFile` (dist-relative), as a dist-relative path to an existing built file. */
function resolveRef(distDir: string, fromFile: string, ref: string): string | null {
  const clean = ref.trim().split(/[?#]/)[0]!;
  if (!clean || /^(?:data:|[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null;
  const abs = clean.startsWith("/") ? path.join(distDir, clean) : path.resolve(path.dirname(path.join(distDir, fromFile)), clean);
  const rel = path.relative(distDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.endsWith(".map")) return null;
  return existsSync(abs) && statSync(abs).isFile() ? rel.split(path.sep).join("/") : null;
}

function cssRefs(css: string): string[] {
  const out = [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of css.matchAll(/@import\s+["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

/**
 * The built files `file` pulls in. A JS chunk's static imports and the images/fonts it names always
 * count; the CSS and other chunks it merely lists (Vite's preload map for lazy routes) count only
 * when `lazy`, i.e. when the chunk itself is one that loads on demand.
 */
function refsOf(distDir: string, file: string, lazy: boolean): string[] {
  const text = readFileSync(path.join(distDir, file), "utf8");
  const raw: string[] = [];
  if (file.endsWith(".css")) raw.push(...cssRefs(text));
  else if (file.endsWith(".js")) {
    for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+\.js)["']/g)) raw.push(m[1]!);
    const ext = lazy ? `css|js|${BINARY_EXT}` : BINARY_EXT;
    for (const m of text.matchAll(new RegExp(`["'\`]((?:[./\\w-]*/)?[\\w.-]+\\.(?:${ext}))["'\`]`, "g"))) raw.push(m[1]!);
  } else return [];
  const out = new Set<string>();
  for (const ref of raw) {
    // JS names files as "/assets/x.png", "./x.js", or bare "assets/x.css" (Vite's preload map)
    const rel = resolveRef(distDir, file, ref) ?? resolveRef(distDir, file, `/${ref.replace(/^\.?\//, "")}`);
    if (rel) out.add(rel);
  }
  return [...out];
}

function closure(distDir: string, roots: string[], exclude: Set<string>, lazy: boolean): Set<string> {
  const found = new Set<string>();
  const queue = [...roots];
  for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
    if (exclude.has(f) || found.has(f)) continue;
    found.add(f);
    queue.push(...refsOf(distDir, f, lazy));
  }
  return found;
}

export function measureBudget(
  distDir: string,
  atlasBytes: { town: number; battle: number },
  limits: { town: number; battle: number } = { town: TOWN_LIMIT_BYTES, battle: BATTLE_LIMIT_BYTES },
): BudgetReport {
  const html = readFileSync(path.join(distDir, "index.html"), "utf8");
  const htmlRefs: string[] = [];
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const rel = resolveRef(distDir, "index.html", m[1]!);
    if (rel && rel !== "index.html") htmlRefs.push(rel);
  }
  const sum = (files: Iterable<string>): number => [...files].reduce((n, f) => n + statSync(path.join(distDir, f)).size, 0);

  const town = closure(distDir, htmlRefs, new Set(), false);
  let lazyJs: string[] = [];
  try {
    lazyJs = readdirSync(path.join(distDir, "assets")).filter((f) => f.endsWith(".js")).map((f) => `assets/${f}`);
  } catch {
    lazyJs = [];
  }
  // the town's own JS lists the lazy chunks and their CSS (Vite's preload map): those load with them
  const listed = [...town].filter((f) => f.endsWith(".js")).flatMap((f) => refsOf(distDir, f, true));
  const battle = closure(distDir, [...lazyJs, ...listed], town, true);

  const townBytes = statSync(path.join(distDir, "index.html")).size + sum(town) + atlasBytes.town;
  const battleBytes = sum(battle) + atlasBytes.battle;
  const findings: Finding[] = [];
  if (townBytes > limits.town) findings.push({ level: "error", id: "budget/town", message: `town first load ${townBytes} bytes, over ${limits.town}` });
  if (battleBytes > limits.battle) findings.push({ level: "error", id: "budget/battle", message: `battle ${battleBytes} bytes, over ${limits.battle}` });
  return { townBytes, battleBytes, findings };
}
