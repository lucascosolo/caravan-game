import { fileURLToPath } from "node:url";
import { REGION_IDS, type RegionId } from "../../packages/content/src/index.js";
import { authoredParties, bestFight, freshRoster, manifestOf, rosterAt, SEARCH, NAIVE, GUIDED, starterTypes, type RosterSpec } from "./sweep.js";
import { runParallel, serveIfChild } from "./parallel.js";

interface Task { roster: RosterSpec; party: number }
function worker(t: Task) {
  const sp = authoredParties()[t.party]!;
  const m = manifestOf(t.roster);
  const s = bestFight(m, sp, SEARCH)!;
  const n = bestFight(m, sp, NAIVE)!;
  const g = bestFight(m, sp, [GUIDED])!;
  return { band: sp.spec.band, s: s.kind, n: n.kind, g: g.kind, st: s.endTick, sl: s.layout };
}
if (!serveIfChild(worker)) {
  const regions: RegionId[] = process.argv.includes("--all") ? [...REGION_IDS] : ["desert", "mountain"];
  const rosters: RosterSpec[] = [];
  for (const r of regions) {
    rosters.push({ ...freshRoster(r, starterTypes(r)[1]!, 1), label: "fresh3" });
    rosters.push({ ...rosterAt(r, { size: 5, level: 1, tier: 1, traps: 3, trapTier: 1, fenceTier: 0, composition: "defensive" }), label: "5xL1" });
    rosters.push({ ...rosterAt(r, { size: 8, level: 2, tier: 2, traps: 6, trapTier: 2, fenceTier: 2, composition: "defensive" }), label: "8xL2" });
    rosters.push({ ...rosterAt(r, { size: 8, level: 3, tier: 3, traps: 6, trapTier: 3, fenceTier: 3, composition: "defensive" }), label: "8xL3" });
    rosters.push({ ...rosterAt(r, { size: 8, level: 4, tier: 4, traps: 6, trapTier: 3, fenceTier: 4, composition: "defensive" }), label: "8xL4" });
    rosters.push({ ...rosterAt(r, { size: 8, level: 5, tier: 4, traps: 6, trapTier: 3, fenceTier: 4, composition: "defensive" }), label: "8xL5" });
  }
  const bands = process.argv.includes("--low") ? [0, 1, 2, 3] : [0, 1, 2, 3, 4, 5, 6, 7];
  const tasks: Task[] = [];
  authoredParties().forEach((p, i) => { if (bands.includes(p.spec.band)) for (const roster of rosters) tasks.push({ roster, party: i }); });
  const t0 = Date.now();
  const res = await runParallel(fileURLToPath(import.meta.url), tasks, worker, 4);
  console.log(`${tasks.length} matchups in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const labels = [...new Set(rosters.map((r) => r.label))];
  for (const fam of ["s", "n", "g"] as const) {
    console.log(`\nfamily ${fam} — held(+stalemate) share by roster × band`);
    console.log("roster".padEnd(8) + bands.map((b) => `b${b}`.padStart(7)).join(""));
    for (const l of labels) {
      const row = bands.map((b) => {
        const xs = res.filter((r, i) => tasks[i]!.roster.label === l && r.band === b);
        const h = xs.filter((r) => r[fam] !== "caravan_overrun").length;
        return `${Math.round((100 * h) / Math.max(1, xs.length))}%`.padStart(7);
      });
      console.log(l.padEnd(8) + row.join(""));
    }
  }
  const lay = new Map<string, number>();
  for (const r of res) if (r.s !== "caravan_overrun") lay.set(r.sl, (lay.get(r.sl) ?? 0) + 1);
  console.log([...lay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15));
}
