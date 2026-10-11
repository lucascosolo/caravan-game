/**
 * Print the bank-or-push EV table for the CURRENT tunables (chunk 19 QA D2c / D3).
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/trip-ev.ts            # the standard table
 *   … trip-ev.ts --curve 0.78,0.62,0.58,0.55 --deaths 0.7 --levels 3,3,3,3,2,2,2,2 --band 4
 *
 * Options (all optional; given any, it prints just that one row):
 *   --p1 <rate> --decay <per-encounter drop>   a linear hold-rate curve (default 0.7, 0.05)
 *   --curve a,b,c,…                           an explicit curve (resolver-measured), last value repeats
 *   --deaths <n>                              expected unit deaths per held encounter (default 0.5)
 *   --levels l1,l2,…                          the packed circle's merge levels (default 8 × 1)
 *   --band <k>                                the caravan's living display band (default REPUTATION_START's)
 *   --final <share>                           share of the alive dying in the overrun fight (default 0.5)
 *   --maxk <k>                                bank points to show (default 6)
 *
 * The model is in ./model.ts (rebuild-valued losses, the server's own earn math). Inputs are
 * guesses until chunk 13's resolver measures them; the §37 balance pass feeds them in.
 */
import { TUNABLES } from "../../packages/content/src/index.js";
import { coinForDelivery, coinForEncounter } from "../../apps/server/src/economy/coin.js";
import { START_BAND, curveHold, evRow, linearHold, rebuildMixed, rebuildPlan, unitValue, weeklyFreeEarn, type TripModelInput } from "./model.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string, d: number): number => {
  const v = arg(name);
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${v}`);
  return n;
};
const list = (name: string): number[] | undefined => arg(name)?.split(",").map((x) => Number(x));

const fmt = (n: number): string => String(Math.round(n)).padStart(7);
const SLOTS = TUNABLES.DEPLOYMENT_SLOT_CAP;
const maxK = num("maxk", 6);

function printRow(label: string, m: TripModelInput): void {
  const r = evRow(m, maxK);
  console.log(`${label.padEnd(34)} ${r.evs.map(fmt).join(" ")}   best k=${r.best}${r.evs[r.best - 1]! > 0 ? "" : "  (no bank point is positive)"}`);
}

const header = `${"".padEnd(34)} ${Array.from({ length: maxK }, (_, i) => `bank@${i + 1}`.padStart(7)).join(" ")}`;

const custom = ["p1", "decay", "curve", "deaths", "levels", "band", "final"].some((n) => arg(n) !== undefined);
if (custom) {
  const curve = list("curve");
  const m: TripModelInput = {
    holdRate: curve ? curveHold(curve) : linearHold(num("p1", 0.7), num("decay", 0.05)),
    deathsPerHeld: num("deaths", 0.5),
    circle: list("levels") ?? Array(SLOTS).fill(1),
    band: num("band", START_BAND),
    finalFightDeathShare: num("final", 0.5),
  };
  console.log(header);
  printRow(`circle ${m.circle.join(",")} band ${m.band}`, m);
} else {
  console.log("Caravan Vaults — trip EV model at the current tunables (scripts/balance/trip-ev.ts)");
  console.log(`COIN_ENCOUNTER_BAND_SCALE_BP ${TUNABLES.COIN_ENCOUNTER_BAND_SCALE_BP}, FIRST_ENCOUNTER_CENTRE_OFFSET ${TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET}, delivery ${TUNABLES.COIN_DELIVERY_PER_ENCOUNTER}/encounter, ×1.35 per encounter`);
  for (const band of [0, START_BAND, 5]) {
    const sched = Array.from({ length: 6 }, (_, i) => coinForEncounter(i + 1, band));
    console.log(`encounter Coin, band ${band}: ${sched.join(", ")}   bank totals: ${sched.map((_, i) => sched.slice(0, i + 1).reduce((a, b) => a + b, 0) + coinForDelivery(i + 1)).join(", ")}`);
  }
  console.log(`unit rebuild value V(L) (mercenary L1, 5→3 amortised): ${[1, 2, 3, 4, 5].map((l) => `L${l} ${Math.round(unitValue(l))}`).join(", ")}`);
  const same = rebuildPlan(SLOTS, 5);
  const mixed = rebuildMixed(Array(SLOTS).fill(5));
  console.log(`rebuild 8 × L5, one type:   ${same.level1} L1, merge ${same.mergeCoin}, +mercenaries ${same.totalCoin}, refugee drip ${same.refugeeHours} h`);
  console.log(`rebuild 8 × L5, mixed types: ${mixed.level1} L1, merge ${mixed.mergeCoin}, +mercenaries ${mixed.totalCoin}, refugee drip ${mixed.refugeeHours} h`);
  console.log("");
  console.log("EV in Coin of 'push until k survived, then bank' — losses at rebuild value; 0.5 deaths per held encounter;");
  console.log("half of the units alive at an overrun die in that fight (de-merged), the rest are destroyed. Hold rate p1 − 0.05·(j−1).");
  console.log(header);
  for (const band of [START_BAND, 5]) {
    for (let level = 1; level <= 5; level++) {
      for (const p1 of [0.6, 0.7, 0.8]) {
        printRow(`8×L${level} band ${band} p1 ${p1.toFixed(2)}`, { holdRate: linearHold(p1, 0.05), deathsPerHeld: 0.5, circle: Array(SLOTS).fill(level), band, finalFightDeathShare: 0.5 });
      }
    }
  }
  console.log("");
  console.log("Weekly free earn (QA D3): full-week trickle + trips × gross Coin per trip, banked at the 8×L1 best-EV point, band " + START_BAND + ", decay 0.05");
  const shapes: [string, number, number][] = [
    ["low  (3 trips/h × 5 h, p1 0.60)", 15, 0.6],
    ["mid  (5 × 1 h sessions, 30 trips, p1 0.65)", 30, 0.65],
    ["high (7 × 1 h sessions, 42 trips, p1 0.70)", 42, 0.7],
  ];
  for (const [label, trips, p1] of shapes) {
    const w = weeklyFreeEarn(trips, p1, 0.05);
    console.log(`  ${label.padEnd(46)} trickle ${w.trickle} + ${trips} × ${Math.round(w.perTrip)} (bank@${w.bankAt}) = ${Math.round(w.total)}`);
  }
  const mid = weeklyFreeEarn(30, 0.65, 0.05).total;
  console.log(`  FREE_WEEKLY_EARN_ESTIMATE ${TUNABLES.FREE_WEEKLY_EARN_ESTIMATE} (mid, rounded down to 1000s: ${Math.floor(mid / 1000) * 1000}); WEEKLY_PAY_CEILING ${TUNABLES.WEEKLY_PAY_CEILING} = ${(TUNABLES.WEEKLY_PAY_CEILING / TUNABLES.FREE_WEEKLY_EARN_ESTIMATE).toFixed(2)}× (bound ${TUNABLES.PAID_TO_FREE_RATIO_MAX_BP / 10_000}×)`);
}
