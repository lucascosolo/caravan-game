/**
 * Unlock pace (final play-test review D8): with the week model's trip counts (model.ts
 * `weeklyFreeEarn`: 15 / 30 / 42 trips a week, 30 the mid), how many days of play until the
 * first tier-2 LIVING unlock is affordable, from the real ladder table (LADDER_POINTS_TO_RUNG,
 * UNLOCK_POINTS_BY_RUNG, LADDER_GAIN_*) and the living node-cost curve.
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/unlock-pace.ts [--curve 0.81,0.78] [--costs 0,1,4,8,14]
 *
 * --curve   hold rate at encounter 1, 2, … (last repeats). Default: the first-trip probe's measured
 *           rates (BALANCE-LOG pass 1: guided encounter 1 held 81 %, encounter 2 78 %).
 * --costs   a living cost curve to evaluate instead of the current one (for before / after).
 *
 * Two paths to the first tier-2 node: saving every unlock point for it (tier-2 living nodes need
 * only a free tier-0 prerequisite), and spending the first point on a tier-1 node as it arrives.
 * Floats are fine here: an offline model, nothing reaches a resolution.
 */
import { TUNABLES } from "../../packages/content/src/index.js";
import { curveHold, unlockPace } from "./model.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const curve = (arg("curve") ?? "0.81,0.78").split(",").map(Number);
const costs = arg("costs")?.split(",").map(Number) ?? [...TUNABLES.UNLOCK_NODE_COST_BY_TIER.living];
const hold = curveHold(curve);

console.log(`Unlock pace — living cost curve ${costs.join(", ")}; hold curve ${curve.join(", ")}; ladder +${TUNABLES.LADDER_GAIN_DEFENSE_HELD} a hold, +${TUNABLES.LADDER_GAIN_LOSS} an overrun; rungs ${TUNABLES.LADDER_POINTS_TO_RUNG.slice(1, 6).join(" / ")} …`);
console.log(`${"trips/week".padEnd(11)}${"bank@".padEnd(6)}${"pts/trip".padStart(9)}${"pts/day".padStart(9)}   save for tier 2           tier 1 first, then tier 2`);
for (const trips of [15, 30, 42]) {
  for (const k of [1, 2, 3]) {
    const p = unlockPace(trips, k, hold, costs);
    const cell = (x: { unlockPoints: number; rung: number; days: number }) => `${x.unlockPoints} pt (rung ${x.rung}) ${x.days.toFixed(1).padStart(5)} d`.padEnd(26);
    console.log(`${String(trips).padEnd(11)}${String(k).padEnd(6)}${p.pointsPerTrip.toFixed(1).padStart(9)}${p.pointsPerDay.toFixed(0).padStart(9)}   ${cell(p.saveForTier2)}${cell(p.tier1First)}`);
  }
}
