/**
 * Studio design review probe: the endgame no live pool has reached yet. Maxed defenders
 * (band-7-typical: 8 units, merge levels up to 5, tier-4 web, best fence, 6 traps) against
 * "meta" standing parties a maxed owner can build (8 × L5 of a region's units, 3 siege pieces),
 * in several stance / edge shapes. Best of the 76 skilled layouts per matchup.
 */
import { REGION_IDS, getUnitType, unlockWebFor, TUNABLES } from "../../../../../packages/content/src/index.js";
import { raiseCell, type Party, type EntryEdge } from "../../../../../packages/circle/src/index.js";
import { runParallel, serveIfChild } from "../../../../../scripts/balance/parallel.js";
import { SKILLED, GUIDED, bandTypicalRoster, rosterAt, fight, better, manifestOf, scoutOf, authoredParties, type ServedParty, type FightResult } from "../../../../../scripts/balance/sweep.js";

const EDGES: EntryEdge[] = ["north", "east", "south", "west"];
type Shape = { name: string; stance: (i: number, typeId: string) => "core" | "nearest" | "traps"; edges: number; siege: string[] };
const SHAPES: Shape[] = [
  { name: "all-core 4 edges", stance: () => "core", edges: 4, siege: ["siege.battering_wagon", "siege.fence_cutters", "siege.blasting_crate"] },
  { name: "all-core 1 edge", stance: () => "core", edges: 1, siege: ["siege.battering_wagon", "siege.fence_cutters", "siege.blasting_crate"] },
  { name: "all-nearest 4 edges", stance: () => "nearest", edges: 4, siege: ["siege.battering_wagon", "siege.fence_cutters", "siege.blasting_crate"] },
  { name: "all-nearest 2 edges", stance: () => "nearest", edges: 2, siege: ["siege.battering_wagon", "siege.fence_cutters", "siege.blasting_crate"] },
  { name: "all-traps 4 edges", stance: () => "traps", edges: 4, siege: ["siege.bridging_planks", "siege.dousing_wagon", "siege.blasting_crate"] },
  { name: "half core half nearest 4 edges", stance: (i) => (i % 2 ? "core" : "nearest"), edges: 4, siege: ["siege.battering_wagon", "siege.fence_cutters", "siege.blasting_crate"] },
];
function metaParty(region: string, shape: Shape, offenseFirst: boolean): ServedParty {
  const types = unlockWebFor("living", region as never).nodes.filter((n) => n.tier <= 1).map((n) => n.id);
  const score = (id: string) => { const t = getUnitType(id)!; return offenseFirst ? t.offense * t.offense * t.hp / (t.attackCooldown) : t.offense * t.hp; };
  const best = [...types].sort((a, b) => score(b) - score(a)).slice(0, 2);
  const units = Array.from({ length: TUNABLES.PARTY_SLOT_CAP }, (_, i) => {
    const typeId = best[i % best.length]!;
    const edge = EDGES[i % shape.edges]!;
    return { ref: `m${i}`, typeId, mergeLevel: 2, stance: shape.stance(i, typeId), edge, cell: raiseCell(edge, i) };
  });
  const party: Party = { v: 1, units, siege: shape.siege.map((typeId) => ({ typeId })) };
  const template = authoredParties()[0]!;
  return { spec: { ...template.spec, username: `meta:${region}:${shape.name}`, rating: 2500 }, party, scout: scoutOf(party), pool: { ...template.pool, partyId: `meta:${region}:${shape.name}`, rating: 2500, authored: false } };
}
const defenders = REGION_IDS.flatMap((r) => [bandTypicalRoster(r, 2, "defensive"), bandTypicalRoster(r, 3, "defensive")]);
const attackers: ServedParty[] = REGION_IDS.flatMap((r) => SHAPES.map((s) => metaParty(r, s, true)));
interface Task { d: number; a: number }
function worker(t: Task) {
  const m = manifestOf(defenders[t.d]!);
  const sp = attackers[t.a]!;
  let best: FightResult | null = null;
  for (const l of SKILLED) { const f = l.build(m, sp.scout); if (!f) continue; const r = fight(m, f, sp, l); if (!best || better(r, best)) best = r; }
  const g = GUIDED.build(m, sp.scout);
  const gr = g ? fight(m, g, sp, GUIDED) : null;
  return { d: t.d, a: t.a, best: best?.kind, guided: gr?.kind, deaths: best?.deaths, hpLeft: best?.hpLeft };
}
if (!serveIfChild(worker)) {
  const tasks: Task[] = [];
  defenders.forEach((_, d) => attackers.forEach((_, a) => tasks.push({ d, a })));
  const out = await runParallel(process.argv[1]!, tasks, worker, 2);
  const byShape = new Map<string, { n: number; held: number; guided: number; deaths: number }>();
  for (const r of out) {
    const s = attackers[r.a]!.spec.username.split(":")[2]!;
    const e = byShape.get(s) ?? { n: 0, held: 0, guided: 0, deaths: 0 };
    e.n++; if (r.best === "caravan_held") e.held++; if (r.guided === "caravan_held") e.guided++; e.deaths += r.deaths ?? 0;
    byShape.set(s, e);
  }
  console.log("maxed defenders (band-7-typical and 8×L5, all regions) vs 8×L5 meta parties, best of 76 layouts / guided:");
  for (const [s, e] of byShape) console.log(`  ${s.padEnd(32)} held ${(100 * e.held / e.n).toFixed(0)}% (guided ${(100 * e.guided / e.n).toFixed(0)}%), deaths per fight ${(e.deaths / e.n).toFixed(1)}  n=${e.n}`);
  const byDef = new Map<string, { n: number; held: number }>();
  for (const r of out) { const k = defenders[r.d]!.label; const e = byDef.get(k) ?? { n: 0, held: 0 }; e.n++; if (r.best === "caravan_held") e.held++; byDef.set(k, e); }
  for (const [k, e] of byDef) console.log(`  defender ${k.padEnd(40)} held ${(100 * e.held / e.n).toFixed(0)}%`);
  const byAtkRegion = new Map<string, { n: number; held: number }>();
  for (const r of out) { const k = attackers[r.a]!.spec.username.split(":")[1]!; const e = byAtkRegion.get(k) ?? { n: 0, held: 0 }; e.n++; if (r.best === "caravan_held") e.held++; byAtkRegion.set(k, e); }
  for (const [k, e] of byAtkRegion) console.log(`  attacker region ${k.padEnd(14)} held against ${(100 * e.held / e.n).toFixed(0)}%`);
}
