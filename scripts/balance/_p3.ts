// exploration: fresh roster variants vs reshaped band-2 parties
import { REGION_IDS, unlockWebFor } from "../../packages/content/src/index.js";
import { authoredPartySpecs, type AuthoredPartySpec } from "../../apps/server/src/matchmaking/authored.js";
import { GUIDED, SKILLED, bestFight, manifestOf, oneFight, servedParty, starterTypes, guidePick, type RosterSpec } from "./sweep.js";
import { runParallel, serveIfChild } from "./parallel.js";

interface T { variant: string; perType: number; traps: number; spec: AuthoredPartySpec; region: string; refugee: number }
function w(t: T) {
  const region = t.region as (typeof REGION_IDS)[number];
  const st = starterTypes(region);
  const units = [] as { typeId: string; mergeLevel: number }[];
  for (const s of st) for (let i = 0; i < t.perType; i++) units.push({ typeId: s, mergeLevel: 1 });
  units.push({ typeId: st[t.refugee]!, mergeLevel: 1 });
  const roster: RosterSpec = { label: "x", regionId: region, units, traps: Array(t.traps).fill("trap.spike_pit"), fence: { tierId: "fence.brush_pile", count: 20 } };
  const m = manifestOf(roster);
  const sp = servedParty(t.spec);
  return { variant: t.variant, perType: t.perType, traps: t.traps, g: oneFight(m, sp, GUIDED)!.kind, b: bestFight(m, sp, SKILLED)!.kind };
}
if (!serveIfChild(w)) {
  const base = authoredPartySpecs().filter((s) => s.band === 2);
  const variants: Record<string, (s: AuthoredPartySpec) => AuthoredPartySpec> = {
    "3xL1 starters": (s) => ({ ...s, units: [0, 1, 2].map((i) => ({ typeId: starterTypes(s.regionId)[i % 2]!, mergeLevel: 1 })), siege: [] }),
    "3xL1 +siege": (s) => ({ ...s, units: [0, 1, 2].map((i) => ({ typeId: starterTypes(s.regionId)[i % 2]!, mergeLevel: 1 })), siege: s.siege.slice(0, 1) }),
    "4xL1 starters": (s) => ({ ...s, units: [0, 1, 2, 3].map((i) => ({ typeId: starterTypes(s.regionId)[i % 2]!, mergeLevel: 1 })), siege: [] }),
    "3 L2lead": (s) => ({ ...s, units: [0, 1, 2].map((i) => ({ typeId: starterTypes(s.regionId)[i % 2]!, mergeLevel: i === 0 ? 2 : 1 })), siege: [] }),
  };
  const tasks: T[] = [];
  for (const [v, f] of Object.entries(variants)) for (const s of base) for (const perType of [1, 2]) for (const traps of [1, 3]) for (const region of REGION_IDS) for (const refugee of [0, 1]) tasks.push({ variant: v, perType, traps, spec: f(s), region, refugee });
  const rs = await runParallel(process.argv[1]!, tasks, w, 4);
  const keyOf = (r: { variant: string; perType: number; traps: number }) => `${r.variant} | start ${r.perType}/type | traps ${r.traps}`;
  const agg = new Map<string, { n: number; g: number; b: number }>();
  for (const r of rs) {
    const k = keyOf(r);
    const a = agg.get(k) ?? { n: 0, g: 0, b: 0 };
    a.n++;
    if (r.g !== "caravan_overrun") a.g++;
    if (r.b !== "caravan_overrun") a.b++;
    agg.set(k, a);
  }
  for (const [k, a] of agg) console.log(k.padEnd(50), `guided ${Math.round((100 * a.g) / a.n)}%  best ${Math.round((100 * a.b) / a.n)}%  (n ${a.n})`);
  void unlockWebFor; void guidePick;
}
