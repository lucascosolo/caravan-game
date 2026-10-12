/**
 * Reputation equilibrium check (final play-test review D6). Reads a matchup sweep's matrix
 * (`matchup-sweep.ts --json`) and reports, under the CURRENT tunables and under the old rule:
 *
 *   caravans  each roster's equilibrium band — the highest band whose skilled encounter-1 hold
 *             rate clears the caravan's break-even, −OVERRUN / (HELD − OVERRUN). D6 does not
 *             touch the caravan's side, so this must be unchanged.
 *   parties   a standing party's expected siege-Reputation drift per strike when it is served to
 *             caravans of display band k. A party of band-p strength (the authored outfits of
 *             band p stand in for it) meets the band-k typical roster (the sweep's assumption) and
 *             wins (overruns) w = 1 − hold. Drift = WIN × w + LOSS × (1 − w), un-gap-scaled
 *             (served in band). With LOSS < 0 the party settles where drift crosses 0; with
 *             LOSS = 0 (D6) drift is never negative, so a party only climbs, ever more slowly, to
 *             the first band where it can no longer win (its ceiling).
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/party-rating.ts sweep.json [--old-loss -15]
 *
 * Floats are fine here: an offline model, nothing reaches a resolution.
 */
import { readFileSync } from "node:fs";
import { TUNABLES } from "../../packages/content/src/index.js";

interface SweepJson {
  matrix: Record<string, Record<string, number>>;
}

const file = process.argv[2];
if (!file) throw new Error("usage: party-rating.ts <sweep.json> [--old-loss n]");
const j = JSON.parse(readFileSync(file, "utf8")) as SweepJson;
const oi = process.argv.indexOf("--old-loss");
const OLD_LOSS = oi >= 0 ? Number(process.argv[oi + 1]) : -15;
const WIN = TUNABLES.REPUTATION_WIN_ATTACKER;
const LOSS = TUNABLES.REPUTATION_LOSS_ATTACKER;
const SPAN = 2 * TUNABLES.REPUTATION_BAND_WIDTH;
const bands = Object.keys(j.matrix["b0-typical defensive"] ?? {}).map(Number).sort((a, b) => a - b);
const pct = (x: number) => `${Math.round(100 * x)}%`.padStart(5);

// ── caravans: unchanged by D6 ──
const breakEven = -TUNABLES.REPUTATION_CARAVAN_OVERRUN / (TUNABLES.REPUTATION_CARAVAN_HELD - TUNABLES.REPUTATION_CARAVAN_OVERRUN);
console.log(`Caravan equilibrium (skilled encounter-1 hold ≥ ${pct(breakEven).trim()}, split +${TUNABLES.REPUTATION_CARAVAN_HELD} / ${TUNABLES.REPUTATION_CARAVAN_OVERRUN}; D6 does not touch it):`);
console.log("  " + Object.keys(j.matrix).map((k) => `${k}: ${bands.filter((b) => (j.matrix[k]?.[b] ?? 0) >= breakEven).pop() ?? "below 0"}`).join(", "));

// ── parties ──
const winRate = (p: number, k: number): number | null => {
  const hold = j.matrix[`b${k}-typical defensive`]?.[p];
  return hold === undefined ? null : 1 - hold;
};
console.log("");
console.log(`Standing party siege-Reputation drift per strike (WIN +${WIN}; LOSS old ${OLD_LOSS}, now ${LOSS}). Rows: party strength (authored band p). Columns: served at band k.`);
console.log(`${"".padEnd(10)}${bands.map((k) => `k=${k}`.padStart(13)).join("")}   old settles   now: ceiling, strikes to climb there from p`);
for (const p of bands) {
  const cells: string[] = [];
  let oldSettle: number | null = null;
  let ceiling: number | null = null;
  let strikes = 0;
  for (const k of bands) {
    const w = winRate(p, k);
    if (w === null) {
      cells.push("–".padStart(13));
      continue;
    }
    const oldDrift = WIN * w + OLD_LOSS * (1 - w);
    const newDrift = WIN * w + LOSS * (1 - w);
    if (oldDrift >= 0) oldSettle = k;
    if (k >= p && ceiling === null) {
      if (newDrift <= 0) ceiling = k;
      else strikes += SPAN / newDrift;
    }
    cells.push(`${oldDrift.toFixed(1).padStart(6)}/${newDrift.toFixed(1).padStart(5)}`.padStart(13));
  }
  const ceil = ceiling === null ? `above b${bands.at(-1)} (still winning there)` : `b${ceiling}`;
  console.log(`${`p=b${p}`.padEnd(10)}${cells.join("")}   ${(oldSettle === null ? "below b0" : `b${oldSettle}`).padEnd(13)} ${ceil}, ≈ ${Math.round(strikes)} strikes`);
}
console.log("");
console.log("Cells: old drift / new drift, Reputation per strike. A party never falls under the new rule; where it can no longer win it stops climbing.");
