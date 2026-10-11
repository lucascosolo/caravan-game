// exploration: global levers vs core runners
import { REGION_IDS } from "../../packages/content/src/index.js";
import { authoredPartySpecs, type AuthoredPartySpec } from "../../apps/server/src/matchmaking/authored.js";
import { EXPLORE, GUIDED, SKILLED, bestFight, manifestOf, oneFight, servedParty, starterTypes, type RosterSpec } from "./sweep.js";
import { runParallel, serveIfChild } from "./parallel.js";

type Lever = "none" | "fence2" | "fence3" | "trap15" | "slow07" | "aggro2" | "hp07" | "fence2slow";
interface T { lever: Lever; perType: number; traps: number; spec: AuthoredPartySpec; region: string }
function apply(lever: Lever) {
  EXPLORE.transform = lever === "none" ? null : (inp) => {
    const x = JSON.parse(JSON.stringify(inp));
    if (lever === "fence2" || lever === "fence3" || lever === "fence2slow") for (const f of x.battlefield.fences) { const k = lever === "fence3" ? 3 : 2; f.hp *= k; f.maxHp *= k; }
    if (lever === "trap15") for (const t of x.battlefield.traps) t.damage = Math.floor(t.damage * 1.5);
    if (lever === "slow07" || lever === "fence2slow") for (const u of x.party.units) u.moveSpeed = Math.floor(u.moveSpeed * 0.7);
    if (lever === "aggro2") for (const p of x.battlefield.posts) p.aggroRadius += 2048;
    if (lever === "hp07") for (const u of x.party.units) { u.hp = Math.floor(u.hp * 0.7); u.maxHp = u.hp; }
    return x;
  };
}
function w(t: T) {
  apply(t.lever);
  const region = t.region as (typeof REGION_IDS)[number];
  const st = starterTypes(region);
  const units = [] as { typeId: string; mergeLevel: number }[];
  for (const s of st) for (let i = 0; i < t.perType; i++) units.push({ typeId: s, mergeLevel: 1 });
  units.push({ typeId: st[1]!, mergeLevel: 1 });
  const roster: RosterSpec = { label: "x", regionId: region, units, traps: Array(t.traps).fill("trap.spike_pit"), fence: { tierId: "fence.brush_pile", count: 20 } };
  const m = manifestOf(roster);
  const sp = servedParty(t.spec);
  return { k: `${t.lever} start${t.perType} traps${t.traps}`, g: oneFight(m, sp, GUIDED)!.kind, b: bestFight(m, sp, SKILLED)!.kind };
}
if (!serveIfChild(w)) {
  const base = authoredPartySpecs().filter((s) => s.band === 2).map((s) => ({ ...s, units: [0, 1, 2].map((i) => ({ typeId: starterTypes(s.regionId)[i % 2]!, mergeLevel: 1 })), siege: [] }));
  const tasks: T[] = [];
  const levers: Lever[] = (process.argv[2]?.split(",") as Lever[]) ?? ["none"];
  for (const lever of levers) for (const [perType, traps] of [[1, 1], [2, 3]] as const) for (const spec of base) for (const region of REGION_IDS) tasks.push({ lever, perType, traps, spec, region });
  const rs = await runParallel(process.argv[1]!, tasks, w, 4);
  const agg = new Map<string, { n: number; g: number; b: number }>();
  for (const r of rs) {
    const a = agg.get(r.k) ?? { n: 0, g: 0, b: 0 };
    a.n++;
    if (r.g !== "caravan_overrun") a.g++;
    if (r.b !== "caravan_overrun") a.b++;
    agg.set(r.k, a);
  }
  for (const [k, a] of agg) console.log(k.padEnd(30), `guided ${Math.round((100 * a.g) / a.n)}%  best ${Math.round((100 * a.b) / a.n)}%  (n ${a.n})`);
}
