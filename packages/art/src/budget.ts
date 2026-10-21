/**
 * The payload budget (PHASE-2 §26): the town's first load (HTML, the JS and CSS index.html pulls
 * in, the town atlas at the 3x WebP worst case) under 8 MB; the battle (its atlas plus every JS
 * chunk loaded lazily, i.e. not referenced from index.html) under 4 MB more.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Finding } from "./coverage.ts";

export const TOWN_LIMIT_BYTES = 8_000_000;
export const BATTLE_LIMIT_BYTES = 4_000_000;

export interface BudgetReport {
  townBytes: number;
  battleBytes: number;
  findings: Finding[];
}

export function measureBudget(
  distDir: string,
  atlasBytes: { town: number; battle: number },
  limits: { town: number; battle: number } = { town: TOWN_LIMIT_BYTES, battle: BATTLE_LIMIT_BYTES },
): BudgetReport {
  const htmlPath = path.join(distDir, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const referenced = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1]!.split(/[?#]/)[0]!.replace(/^\.?\//, "");
    if (ref.startsWith("assets/")) referenced.add(ref);
  }
  let townBytes = statSync(htmlPath).size + atlasBytes.town;
  let battleBytes = atlasBytes.battle;
  const assetsDir = path.join(distDir, "assets");
  let files: string[] = [];
  try {
    files = readdirSync(assetsDir);
  } catch {
    files = [];
  }
  for (const f of files) {
    if (f.endsWith(".map")) continue;
    const size = statSync(path.join(assetsDir, f)).size;
    if (referenced.has(`assets/${f}`)) townBytes += size;
    else if (f.endsWith(".js")) battleBytes += size;
  }
  const findings: Finding[] = [];
  if (townBytes > limits.town) findings.push({ level: "error", id: "budget/town", message: `town first load ${townBytes} bytes, over ${limits.town}` });
  if (battleBytes > limits.battle) findings.push({ level: "error", id: "budget/battle", message: `battle ${battleBytes} bytes, over ${limits.battle}` });
  return { townBytes, battleBytes, findings };
}
