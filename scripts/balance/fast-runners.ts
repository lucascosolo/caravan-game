/**
 * Final play-test review r2 D1: fast core- and trap-stance runners. The round-2 week saw most
 * week-1 overruns end in 7–18 s with 0 raiders killed and every packed unit still standing lost
 * (PROJECT.md §13 keeps that rule). This probe measures how often that happens in the fights a
 * week-1 caravan meets, so a content-only lever (trap trigger, runner speed, the low-band authored
 * mix) can be tried with `--explore` before anything is written into content:
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/fast-runners.ts [--explore speed=0.85] [--explore trapRadius=1536]
 *
 * Fights: every band-0 and band-1 authored outfit with a core- or trap-stance raider, against each
 * region's fresh roster (each refugee type, GUIDE_RESERVE left home, one trap) — with the guided
 * layout and with the best of the skilled set. Reported: overrun share, the share of overruns that
 * end within 20 s, and units alive (= lost) at those overruns.
 *
 * Floats are fine here: an offline report, nothing reaches a resolution.
 */
import { REGION_IDS, TUNABLES } from "../../packages/content/src/index.js";
import { GUIDED, SKILLED, authoredParties, bestFight, freshRoster, manifestOf, oneFight, starterTypes, type FightResult } from "./sweep.js";

const runners = authoredParties().filter((p) => p.spec.band <= 1 && p.party.units.some((u) => u.stance === "core" || u.stance === "traps"));
const rosters = REGION_IDS.flatMap((r) => starterTypes(r).map((refugee) => {
  const full = freshRoster(r, refugee, 1);
  return manifestOf({ ...full, units: full.units.slice(0, full.units.length - TUNABLES.GUIDE_RESERVE) });
}));
const fastTicks = 20 * TUNABLES.TICK_RATE;

function tally(label: string, fights: (FightResult | null)[]): void {
  const done = fights.filter((f): f is FightResult => f !== null);
  const over = done.filter((f) => f.kind === "caravan_overrun");
  const fast = over.filter((f) => f.endTick <= fastTicks);
  const alive = (f: FightResult) => f.survivors.units.filter((u) => u.hp > 0).length;
  const lost = fast.reduce((s, f) => s + alive(f), 0);
  const pct = (a: number, b: number) => `${b === 0 ? 0 : Math.round((100 * a) / b)}%`;
  console.log(
    `${label.padEnd(14)} fights ${done.length}  overrun ${pct(over.length, done.length).padStart(4)}  of which within 20 s ${pct(fast.length, over.length).padStart(4)}  ` +
      `units standing (lost) per fast overrun ${fast.length === 0 ? "–" : (lost / fast.length).toFixed(1)}`,
  );
}

console.log(`${runners.length} band-0/1 authored outfits with a core- or trap-stance raider × ${rosters.length} fresh rosters (reserve ${TUNABLES.GUIDE_RESERVE})${process.argv.includes("--explore") ? `; explore ${process.argv[process.argv.indexOf("--explore") + 1]}` : ""}`);
const guided: (FightResult | null)[] = [];
const skilled: (FightResult | null)[] = [];
for (const sp of runners) for (const m of rosters) {
  guided.push(oneFight(m, sp, GUIDED));
  skilled.push(bestFight(m, sp, SKILLED));
}
tally("guided", guided);
tally("best skilled", skilled);
