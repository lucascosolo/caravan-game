/**
 * Final play-test review r3 D2: authored outliers. For every authored party, the share of its
 * band's typical rosters that the BEST skilled layout holds against it:
 *   - band-typical: `bandTypicalRoster` of the party's band ordinal, every region, the
 *     "defensive" and "mixed" compositions (8 rosters);
 *   - in bands 0–1 also the caravan that actually meets them in week 1: the fresh roster
 *     (STARTING_ROSTER + each refugee type) packing all but GUIDE_RESERVE, one trap (8 rosters).
 * A party is an outlier when either share is under OUTLIER_HOLD (20 %, the orchestrator's bar).
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/outliers.ts [--jobs 2] [--bands 0,1]
 *
 * Floats are fine here: an offline report, nothing reaches a resolution.
 */
import { REGION_IDS, TUNABLES } from "../../packages/content/src/index.js";
import { runParallel, serveIfChild } from "./parallel.js";
import { SKILLED, authoredParties, bandTypicalRoster, bestFight, freshRoster, manifestOf, starterTypes, type RosterSpec } from "./sweep.js";

/** Tunable (r3 D2): the bar under which an authored party is re-authored. */
export const OUTLIER_HOLD = 0.2;

export interface OutlierTask {
  readonly party: number;
  readonly roster: RosterSpec;
  readonly kind: "typical" | "fresh";
}

export function rostersFor(bandOrdinal: number): { roster: RosterSpec; kind: "typical" | "fresh" }[] {
  const out: { roster: RosterSpec; kind: "typical" | "fresh" }[] = [];
  for (const r of REGION_IDS) for (const c of ["defensive", "mixed"] as const) out.push({ roster: bandTypicalRoster(r, bandOrdinal, c), kind: "typical" });
  if (bandOrdinal <= 1) {
    for (const r of REGION_IDS) for (const refugee of starterTypes(r)) {
      const full = freshRoster(r, refugee, 1);
      out.push({ roster: { ...full, units: full.units.slice(0, full.units.length - TUNABLES.GUIDE_RESERVE) }, kind: "fresh" });
    }
  }
  return out;
}

export function outlierFight(t: OutlierTask): boolean {
  const sp = authoredParties()[t.party]!;
  const r = bestFight(manifestOf(t.roster), sp, SKILLED);
  return r !== null && r.kind !== "caravan_overrun";
}

const isMain = process.argv[1]?.endsWith("outliers.ts") ?? false;
if (isMain && !serveIfChild(outlierFight)) {
  const ji = process.argv.indexOf("--jobs");
  const jobs = ji >= 0 ? Number(process.argv[ji + 1]) : 2;
  const bi = process.argv.indexOf("--bands");
  const bands = bi >= 0 ? process.argv[bi + 1]!.split(",").map(Number) : null;
  const parties = authoredParties();
  const tasks: OutlierTask[] = [];
  parties.forEach((sp, party) => {
    if (bands && !bands.includes(sp.spec.band)) return;
    for (const { roster, kind } of rostersFor(sp.spec.band)) tasks.push({ party, roster, kind });
  });
  const rs = await runParallel(process.argv[1]!, tasks, outlierFight, jobs);
  const by = new Map<number, { typical: [number, number]; fresh: [number, number] }>();
  tasks.forEach((t, i) => {
    const e = by.get(t.party) ?? { typical: [0, 0], fresh: [0, 0] };
    const slot = e[t.kind];
    slot[1]++;
    if (rs[i]) slot[0]++;
    by.set(t.party, e);
  });
  console.log(`r3 D2 — authored outliers: best of ${SKILLED.length} skilled layouts vs the band's typical rosters (and, in bands 0–1, the fresh guided pack); bar ${OUTLIER_HOLD * 100} %`);
  let lastBand = -1;
  for (const [party, e] of [...by.entries()].sort((a, b) => parties[a[0]]!.spec.band - parties[b[0]]!.spec.band || a[0] - b[0])) {
    const sp = parties[party]!;
    if (sp.spec.band !== lastBand) {
      lastBand = sp.spec.band;
      const inBand = [...by.entries()].filter(([p]) => parties[p]!.spec.band === lastBand);
      const t = inBand.reduce((a, [, v]) => [a[0] + v.typical[0], a[1] + v.typical[1]], [0, 0]);
      console.log(`band ${lastBand}: band-typical held ${t[0]}/${t[1]} = ${Math.round((100 * t[0]) / Math.max(1, t[1]))}%`);
    }
    const share = (x: [number, number]) => (x[1] === 0 ? null : x[0] / x[1]);
    const st = share(e.typical);
    const sf = share(e.fresh);
    const flag = (st !== null && st < OUTLIER_HOLD) || (sf !== null && sf < OUTLIER_HOLD) ? "  << OUTLIER" : "";
    const units = sp.party.units.length;
    const stances = [...new Set(sp.party.units.map((u) => u.stance))].join("/");
    console.log(`  ${sp.spec.outfit.name.padEnd(28)} ${sp.spec.regionId.padEnd(12)} ${String(units).padStart(2)} raiders ${stances.padEnd(20)} typical ${e.typical[0]}/${e.typical[1]}${e.fresh[1] ? `   fresh-5 ${e.fresh[0]}/${e.fresh[1]}` : ""}${flag}`);
  }
}
