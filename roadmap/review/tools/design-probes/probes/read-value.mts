/**
 * Studio design review probe (not part of the repo): how much does the per-encounter read matter?
 * For each band-typical roster (4 regions, defensive, band ordinals 0-7) against every authored
 * party within ±1 band of it, fight ALL 76 skilled layouts, plus the same 76 with the scout's main
 * edge replaced by a fixed "north" (a player who ignores where the raiders come from).
 * Output JSON: per matchup, per layout, outcome code (2 held, 1 stalemate, 0 overrun) and hpLeft.
 */
import { writeFileSync } from "node:fs";
import { REGION_IDS } from "../../../../../packages/content/src/index.js";
import { runParallel, serveIfChild } from "../../../../../scripts/balance/parallel.js";
import {
  SKILLED,
  authoredParties,
  bandTypicalRoster,
  fight,
  freshRoster,
  manifestOf,
  starterTypes,
  type RosterSpec,
  type Scout,
} from "../../../../../scripts/balance/sweep.js";
import { bandOf, bandCentre } from "../../../../../apps/server/src/matchmaking/band.js";
import { TUNABLES } from "../../../../../packages/content/src/index.js";

const rosters: { o: number; spec: RosterSpec }[] = [];
for (const r of REGION_IDS) {
  rosters.push({ o: 0, spec: { ...freshRoster(r, starterTypes(r)[1]!, TUNABLES.TRAP_SLOT_CAP), label: `fresh ${r}` } });
  for (let o = 1; o < 8; o++) rosters.push({ o, spec: bandTypicalRoster(r, o, "defensive") });
}
const parties = authoredParties();
const partyBand = parties.map((p) => bandOf(p.spec.rating).index);

interface Task { r: number; p: number }
interface Res { r: number; p: number; band: number; o: number; read: number[]; hp: number[]; blind: number[]; blindHp: number[] }

function worker(t: Task): Res {
  const { o, spec } = rosters[t.r]!;
  const sp = parties[t.p]!;
  const m = manifestOf(spec);
  const read: number[] = [], hp: number[] = [], blind: number[] = [], blindHp: number[] = [];
  const blindScout: Scout = { ...sp.scout, main: "north", byEdge: [{ edge: "north", raiders: 1 }, { edge: "east", raiders: 0 }, { edge: "south", raiders: 0 }, { edge: "west", raiders: 0 }], edges: ["north"] };
  for (const l of SKILLED) {
    const f = l.build(m, sp.scout);
    if (!f) { read.push(-1); hp.push(0); } else {
      const r = fight(m, f, sp, l);
      read.push(r.kind === "caravan_held" ? 2 : r.kind === "stalemate" ? 1 : 0);
      hp.push(Math.round(r.hpLeft * 1000));
    }
    const fb = l.build(m, blindScout);
    if (!fb) { blind.push(-1); blindHp.push(0); } else {
      const r = fight(m, fb, sp, l);
      blind.push(r.kind === "caravan_held" ? 2 : r.kind === "stalemate" ? 1 : 0);
      blindHp.push(Math.round(r.hpLeft * 1000));
    }
  }
  return { r: t.r, p: t.p, band: partyBand[t.p]!, o, read, hp, blind, blindHp };
}

if (!serveIfChild(worker)) {
  const tasks: Task[] = [];
  rosters.forEach((ro, r) => parties.forEach((_, p) => { if (Math.abs(partyBand[p]! - ro.o) <= 1) tasks.push({ r, p }); }));
  const jobs = Number(process.argv[process.argv.indexOf("--jobs") + 1] ?? 2) || 2;
  console.log(`tasks ${tasks.length}, layouts ${SKILLED.length}, jobs ${jobs}`);
  const t0 = Date.now();
  const out = await runParallel(process.argv[1]!, tasks, worker, jobs, (d, n) => { if (d % 100 === 0) console.log(`${d}/${n} ${((Date.now() - t0) / 1000).toFixed(0)}s`); });
  writeFileSync(process.argv[process.argv.indexOf("--json") + 1]!, JSON.stringify({ layouts: SKILLED.map((l) => l.name), rosters: rosters.map((x) => x.spec.label), parties: parties.map((p) => ({ name: p.spec.outfit.name, band: bandOf(p.spec.rating).index, units: p.party.units.length, stances: p.party.units.map((u) => u.stance), edges: [...new Set(p.party.units.map((u) => u.edge))], siege: p.party.siege.map((s) => s.typeId) })), results: out }));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  void bandCentre;
}
