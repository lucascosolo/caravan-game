/**
 * Trip EV at MEASURED hold rates (chunk 19 QA D2c, PHASE-2 §37): feeds the matchup sweep's trip
 * curves into the trip-EV model (model.ts, the same one trip-ev.ts prints).
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/matchup-sweep.ts --json sweep.json
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/measured-ev.ts sweep.json [--final 0.5]
 *
 * For each band-typical roster (merge level L) it takes the roster's EQUILIBRIUM band (the
 * highest band whose skilled encounter-1 hold rate clears the Reputation break-even) and that
 * band's measured pushed-trip curve and deaths per held encounter. Two rows each:
 *   - skilled: the skilled curve (best of the menu, best of the search set);
 *   - no choice: encounter 1 at the matrix's per-party skilled hold rate (no picking the easiest
 *     of three), later encounters scaled by the same ratio — the cautious end.
 * Then the weekly free earn (chunk 19 QA D3) re-derived with the measured 8 × L1 curve at its
 * equilibrium band, against WEEKLY_PAY_CEILING and the 1.5× bound.
 */
import { readFileSync } from "node:fs";
import { TUNABLES } from "../../packages/content/src/index.js";
import { curveHold, evRow, type TripModelInput } from "./model.js";
import { playerLevelAt } from "./sweep.js";

interface SweepJson {
  matrix: Record<string, Record<string, number>>;
  tripCurves: Record<string, { skilled: number[]; naive: number[]; deathsPerHeld: number }>;
  finalFightDeathShare?: number;
}

const file = process.argv[2];
if (!file) throw new Error("usage: measured-ev.ts <sweep.json> [--final share]");
const j = JSON.parse(readFileSync(file, "utf8")) as SweepJson;
const fi = process.argv.indexOf("--final");
const final = fi >= 0 ? Number(process.argv[fi + 1]) : (j.finalFightDeathShare ?? 0.5);
const breakEven = -TUNABLES.REPUTATION_CARAVAN_OVERRUN / (TUNABLES.REPUTATION_CARAVAN_HELD - TUNABLES.REPUTATION_CARAVAN_OVERRUN);
const SLOTS = TUNABLES.DEPLOYMENT_SLOT_CAP;
const clean = (xs: number[]) => {
  const out: number[] = [];
  for (const x of xs) if (x !== null && !Number.isNaN(x)) out.push(x);
  else break;
  return out.length ? out : [0];
};
const fmt = (n: number) => String(Math.round(n)).padStart(7);

console.log(`Trip EV at measured hold rates — ${file}; overrun-fight death share ${final}; break-even hold ${(100 * breakEven).toFixed(0)}%`);
console.log(`${"".padEnd(44)} ${[1, 2, 3, 4, 5].map((k) => `bank@${k}`.padStart(7)).join(" ")}`);
const rows: { level: number; best: number; positive: boolean }[] = [];
for (const [key, byBand] of Object.entries(j.matrix)) {
  const m = /^b(\d)-typical defensive$/.exec(key);
  if (!m) continue;
  const o = Number(m[1]);
  const level = playerLevelAt(o);
  const bands = Object.keys(byBand).map(Number).sort((a, b) => a - b);
  const eq = bands.filter((b) => byBand[b]! >= breakEven).pop() ?? 0;
  const tc = j.tripCurves[eq];
  if (!tc) continue;
  const skilled = clean(tc.skilled);
  const p1 = byBand[eq]!;
  const noChoice = skilled.map((p) => Math.min(1, p * (p1 / Math.max(1e-9, skilled[0]!))));
  for (const [label, curve] of [["skilled", skilled], ["no choice", noChoice]] as const) {
    const input: TripModelInput = { holdRate: curveHold(curve), deathsPerHeld: tc.deathsPerHeld, circle: Array(SLOTS).fill(level), band: eq, finalFightDeathShare: final };
    const r = evRow(input, 5);
    const pos = r.evs[r.best - 1]! > 0;
    if (label === "skilled") rows.push({ level, best: r.best, positive: pos });
    console.log(`${`${key} (8×L${level}) @ band ${eq} ${label}`.padEnd(44)} ${r.evs.map(fmt).join(" ")}   best k=${r.best}${pos ? "" : "  (no bank point is positive)"}   curve ${curve.map((x) => x.toFixed(2)).join(",")} deaths/held ${tc.deathsPerHeld.toFixed(2)}`);
  }
}
const l1 = j.tripCurves[Object.entries(j.matrix["b0-typical defensive"] ?? {}).filter(([, v]) => v >= breakEven).map(([b]) => b).pop() ?? "0"];
if (l1) {
  const eq = Number(Object.entries(j.matrix["b0-typical defensive"] ?? {}).filter(([, v]) => v >= breakEven).map(([b]) => b).pop() ?? 0);
  const input: TripModelInput = { holdRate: curveHold(clean(l1.skilled)), deathsPerHeld: l1.deathsPerHeld, circle: Array(SLOTS).fill(1), band: eq, finalFightDeathShare: final };
  const r = evRow(input, 5);
  const perTrip = r.gross[r.best - 1]!;
  const trickle = TUNABLES.COIN_TRICKLE_RATE_PER_HOUR * 24 * 7;
  console.log("");
  console.log(`Weekly free earn at the measured 8×L1 curve (band ${eq}, bank@${r.best}, ${Math.round(perTrip)} Coin a trip): ` + [15, 30, 42].map((t) => `${t} trips ${Math.round(trickle + t * perTrip)}`).join(", "));
  const mid = trickle + 30 * perTrip;
  console.log(`  mid ${Math.round(mid)} → FREE_WEEKLY_EARN_ESTIMATE would be ${Math.floor(mid / 1000) * 1000} (now ${TUNABLES.FREE_WEEKLY_EARN_ESTIMATE}); WEEKLY_PAY_CEILING ${TUNABLES.WEEKLY_PAY_CEILING} = ${(TUNABLES.WEEKLY_PAY_CEILING / (Math.floor(mid / 1000) * 1000)).toFixed(2)}× of it (bound ${TUNABLES.PAID_TO_FREE_RATIO_MAX_BP / 10_000}×)`);
}
