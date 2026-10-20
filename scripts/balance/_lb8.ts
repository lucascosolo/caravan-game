// scratch (deleted before commit): custom variants for the hard band-1 outfits.
import { runParallel, serveIfChild } from "./parallel.js";
import { freshPacks } from "./low-bands.js";
import { GUIDED, authoredParties, manifestOf, oneFight, servedParty } from "./sweep.js";
import type { AuthoredPartySpec } from "../../apps/server/src/matchmaking/authored.js";

type V = { name: string; f: (s: AuthoredPartySpec) => AuthoredPartySpec };
const st = (p: AuthoredPartySpec["stancePattern"]) => (s: AuthoredPartySpec) => ({ ...s, stancePattern: p });
const drop = (k: number) => (s: AuthoredPartySpec) => ({ ...s, units: s.units.slice(0, s.units.length - k) });
const noSiege = (s: AuthoredPartySpec) => ({ ...s, siege: [] });
const oneEdge = (s: AuthoredPartySpec) => ({ ...s, edges: [s.edges[0]!], edgeCount: 1 as const });
const twoEdge = (s: AuthoredPartySpec) => ({ ...s, edges: s.edges.slice(0, 2), edgeCount: 2 as const });
const c = (...fs: ((s: AuthoredPartySpec) => AuthoredPartySpec)[]) => (s: AuthoredPartySpec) => fs.reduce((a, f) => f(a), s);
const types = (ts: string[]) => (s: AuthoredPartySpec) => ({ ...s, units: s.units.map((u, i) => ({ ...u, typeId: ts[i % ts.length]! })) });
const G = "mountain.grizzly", TR = "mountain.trapper";
const sg = (x: string[]) => (s: AuthoredPartySpec) => ({ ...s, siege: x });
const BW = "siege.battering_wagon", BP = "siege.bridging_planks";
const VS: V[] = [
  { name: "asis", f: (s) => s },
  { name: "traps/bw", f: c(st("traps"), sg([BW])) },
  { name: "traps/bp", f: c(st("traps"), sg([BP])) },
  { name: "nearest/bw", f: c(st("nearest"), sg([BW])) },
  { name: "nearest/bp", f: c(st("nearest"), sg([BP])) },
  { name: "nearest/none", f: c(st("nearest"), sg([])) },
  { name: "traps/none", f: c(st("traps"), sg([])) },
  { name: "tt/nearest/bw", f: c(types([TR]), st("nearest"), sg([BW])) },
  { name: "tt/traps/bw", f: c(types([TR]), st("traps"), sg([BW])) },
  { name: "tt/nearest/none", f: c(types([TR]), st("nearest"), sg([])) },
  { name: "tt/traps/none", f: c(types([TR]), st("traps"), sg([])) },
  { name: "gt/traps/none", f: c(types([G, TR]), st("traps"), sg([])) },
  { name: "tg/traps/none", f: c(types([TR, G]), st("traps"), sg([])) },
  { name: "tg/nearest/none", f: c(types([TR, G]), st("nearest"), sg([])) },
];
const OUT = ["The Avalanche Club"];
interface T { o: string; v: number; p: number }
let packs: ReturnType<typeof freshPacks> | undefined;
function work(t: T): boolean {
  packs ??= freshPacks();
  const base = authoredParties().find((x) => x.spec.outfit.name === t.o)!.spec;
  const r = oneFight(manifestOf(packs[t.p]!), servedParty(VS[t.v]!.f(base)), GUIDED);
  return r !== null && r.kind !== "caravan_overrun";
}
if (!serveIfChild(work)) {
  const n = freshPacks().length;
  const tasks: T[] = [];
  for (const o of OUT) for (let v = 0; v < VS.length; v++) for (let p = 0; p < n; p++) tasks.push({ o, v, p });
  const rs = await runParallel(process.argv[1]!, tasks, work, 2);
  const h = new Map<string, number>();
  tasks.forEach((t, i) => { if (rs[i]) h.set(`${t.o}|${t.v}`, (h.get(`${t.o}|${t.v}`) ?? 0) + 1); });
  for (const o of OUT) console.log(`${o.padEnd(24)} ` + VS.map((v, i) => `${v.name} ${h.get(`${o}|${i}`) ?? 0}`).join(" · "));
}
