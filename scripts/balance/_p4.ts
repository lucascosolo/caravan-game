// exploration: fight anatomy, 3 L1 starters each side, per raider stance pattern
import { authoredPartySpecs } from "../../apps/server/src/matchmaking/authored.js";
import { resolve } from "../../packages/resolver/src/index.js";
import { resolverInputOf } from "../../apps/server/src/trip/resolverAdapter.js";
import { GUIDED, SKILLED, manifestOf, servedParty, starterTypes, better, fight, type FightResult } from "./sweep.js";

const specs = authoredPartySpecs().filter((s) => s.band === 2 && s.regionId === "desert" || (s.band === 2 && s.regionId === "mountain"));
for (const s0 of specs) {
  const s = { ...s0, units: [0, 1, 2].map((i) => ({ typeId: starterTypes(s0.regionId)[i % 2]!, mergeLevel: 1 })), siege: [] };
  const sp = servedParty(s);
  const st = starterTypes("desert");
  const m = manifestOf({ label: "x", regionId: "desert", units: [st[0]!, st[1]!, st[1]!, st[0]!, st[1]!].map((t) => ({ typeId: t, mergeLevel: 1 })), traps: ["trap.spike_pit", "trap.spike_pit", "trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 20 } });
  let best: FightResult | null = null;
  let bestF = null;
  for (const l of SKILLED) {
    const f = l.build(m, sp.scout);
    if (!f) continue;
    const r = fight(m, f, sp, l);
    if (!best || better(r, best)) { best = r; bestF = f; }
  }
  const out = resolve(resolverInputOf({ tripId: "x", encounterIndex: 1, formation: bestF!, survivors: m, party: sp.party, contentHash: null }));
  console.log(`\n${s.username} stance=${s.stancePattern} edges=${s.edges} raiders=${s.units.map((u) => u.typeId.split(".")[1]).join(",")} best=${best!.layout} ${best!.kind} end=${out.outcome.endTick}`);
  for (const u of out.units) console.log(`  ${u.side.padEnd(8)} ${u.typeId.padEnd(22)} hp ${u.hp}/${u.maxHp} died@${u.diedTick} core@${u.reachedCoreTick}`);
  const traps = out.log.filter((e) => e.k === "trap_fired").length;
  const fb = out.log.filter((e) => e.k === "fence_broken").length;
  console.log(`  traps fired ${traps}, fences broken ${fb}`);
  void GUIDED;
}
