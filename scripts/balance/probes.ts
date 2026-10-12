/**
 * The two standing probes from chunk 12's QA list, as sweeps (PHASE-2 §37):
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/probes.ts [--jobs 2]
 *
 * 1. HEALER STALEMATE. Can a circle built to survive rather than to kill farm the tick cap (a
 *    stalemate favours the caravan)? Per region: the maximal turtle — eight level-5 posts, four of
 *    them the region's healer and four its sturdiest guards, a full Stacked Stone fence and six of
 *    the heaviest traps — against every party of the top two authored bands, arranged by the best
 *    of the skilled set plus the same shapes on `hold` (counting a stalemate as the caravan's best
 *    result, which it is). Reported: held / stalemate / overrun and the healing offset.
 *    Acceptance: stalemates stay a minority (< STALEMATE_FARM_MAX of these fights) — the safety
 *    valve is not a reliable win condition.
 * 2. STRUCTURE-BREAKER STACKING. Every structure-breaker type × merge level 1–5 × its counter
 *    siege on/off × every fence tier: one raider on `core` against a circle whose only open side
 *    is the far one, so breaching is the short way in. Reported: the most any one unit took from
 *    one segment in one tick (normal hit + breaker summed, as a share of the segment's max HP) —
 *    must never exceed FENCE_HIT_SEGMENT_CAP — and how many fights broke at least one segment.
 */
import { CONTENT, FIXED_ONE, REGION_IDS, TUNABLES, getUnitType, type RegionId } from "../../packages/content/src/index.js";
import { RING_SEGMENTS, entryBand, packManifest, type Formation, type Party } from "../../packages/circle/src/index.js";
import { resolve } from "../../packages/resolver/src/index.js";
import { resolverInputOf } from "../../apps/server/src/trip/resolverAdapter.js";
import { runParallel, serveIfChild } from "./parallel.js";
import { SKILLED, authoredParties, bestFight, manifestOf, pct, searchLayout, share, typesUpTo, type Layout, type RosterSpec } from "./sweep.js";

/** Tunable (chunk 37): the most of the turtle's fights that may end at the tick cap before stalemate farming counts as reachable. */
export const STALEMATE_FARM_MAX = 0.25;

const HOLD_SHAPES: readonly Layout[] = ["pinhole", "openFront", "openBack", "pinholeBack"].flatMap((g) => ["behind", "coreFront", "coreRing"].flatMap((p) => ["lane", "core", "coreRing"].map((t) => searchLayout(g, p, "hold", t))));

export function turtleRoster(regionId: RegionId): RosterSpec {
  const types = typesUpTo(regionId, TUNABLES.UNLOCK_WEB_TIERS);
  const healer = types.find((t) => getUnitType(t)!.ability.archetype === "heal_radius")!;
  const sturdy = types.filter((t) => t !== healer).sort((a, b) => getUnitType(b)!.defense * getUnitType(b)!.hp - getUnitType(a)!.defense * getUnitType(a)!.hp);
  const units = [healer, healer, healer, healer, ...sturdy.slice(0, 4)].map((typeId) => ({ typeId, mergeLevel: TUNABLES.MERGE_LEVEL_MAX }));
  const traps = [...CONTENT.traps].sort((a, b) => b.damage - a.damage).slice(0, TUNABLES.TRAP_SLOT_CAP).map((t) => t.id);
  return { label: `turtle ${regionId}`, regionId, units, traps, fence: { tierId: "fence.stacked_stone", count: TUNABLES.FENCE_MATERIAL_BUDGET } };
}

interface HealerTask { readonly kind: "healer"; readonly region: RegionId; readonly party: number }
interface BreakerTask { readonly kind: "breaker"; readonly typeId: string; readonly level: number; readonly siege: boolean; readonly tierId: string }
type Task = HealerTask | BreakerTask;
interface HealerRow { readonly kind: string; readonly healed: number; readonly taken: number }
interface BreakerRow { readonly worstShare: number; readonly broke: boolean }

function work(t: Task): HealerRow | BreakerRow {
  if (t.kind === "healer") {
    const m = manifestOf(turtleRoster(t.region));
    const r = bestFight(m, authoredParties()[t.party]!, [...SKILLED, ...HOLD_SHAPES])!;
    return { kind: r.kind, healed: r.healed, taken: r.postDamageTaken };
  }
  const tier = CONTENT.fences.find((f) => f.id === t.tierId)!;
  const counter = CONTENT.siege.find((s) => s.counters.kind === "fence" && s.counters.category === tier.category)!;
  const m = packManifest({ units: [{ instanceId: "u0", typeId: typesUpTo("desert", 0)[1]!, mergeLevel: 1 }], traps: [], fence: { tierId: t.tierId, count: Math.min(TUNABLES.FENCE_MATERIAL_BUDGET, RING_SEGMENTS.filter((s) => s.edge !== "south").length) } }, () => true);
  if (!m.ok) throw new Error("breaker probe manifest");
  // Fence north, east and west, and the south side's two ends: the only gaps are on the far (south) side.
  const order = RING_SEGMENTS.filter((s) => s.edge !== "south").map((s) => s.index);
  const f: Formation = { v: 2, fences: m.value.fences.map((x, i) => ({ ref: x.ref, segment: order[i]! })), traps: [], posts: [{ ref: "u0", cell: { x: 15, y: 20 }, stance: "hold" }] };
  const party: Party = { v: 1, units: [{ ref: "b0", typeId: t.typeId, mergeLevel: t.level, stance: "core", edge: "north", cell: entryBand("north")[15]! }], siege: t.siege ? [{ typeId: counter.id }] : [] };
  const out = resolve(resolverInputOf({ tripId: "probe", encounterIndex: 1, formation: f, survivors: m.value, party, contentHash: null }));
  const dealt = new Map<string, number>();
  const bump = (tick: number, u: number, fi: number, amount: number) => dealt.set(`${tick}:${u}:${fi}`, (dealt.get(`${tick}:${u}:${fi}`) ?? 0) + amount);
  for (const e of out.log) {
    if (e.k === "fence_hit") bump(e.t, e.u, e.f, e.damage);
    else if (e.k === "ability") for (const g of e.tg) if (g.kind === "fence") bump(e.t, e.u, g.id, g.amount);
  }
  let worst = 0;
  for (const [k, v] of dealt) worst = Math.max(worst, v / out.fences[Number(k.split(":")[2])]!.maxHp);
  return { worstShare: worst, broke: out.fences.some((x) => !x.intact) };
}

const isMain = process.argv[1]?.endsWith("probes.ts") ?? false;
if (isMain && !serveIfChild(work)) {
  const i = process.argv.indexOf("--jobs");
  const jobs = i >= 0 ? Number(process.argv[i + 1]) : 2;
  const parties = authoredParties();
  const top = parties.map((p, idx) => ({ p, idx })).filter(({ p }) => p.spec.band >= Math.max(...parties.map((x) => x.spec.band)) - 1);
  const healerTasks: HealerTask[] = REGION_IDS.flatMap((region) => top.map(({ idx }) => ({ kind: "healer" as const, region, party: idx })));
  const breakers = CONTENT.units.filter((u) => u.ability.archetype === "structure_breaker").map((u) => u.id);
  const breakerTasks: BreakerTask[] = breakers.flatMap((typeId) => [1, 2, 3, 4, 5].flatMap((level) => [false, true].flatMap((siege) => CONTENT.fences.map((f) => ({ kind: "breaker" as const, typeId, level, siege, tierId: f.id })))));
  const rows = await runParallel(process.argv[1]!, [...healerTasks, ...breakerTasks], work, jobs);
  const h = rows.slice(0, healerTasks.length) as HealerRow[];
  const b = rows.slice(healerTasks.length) as BreakerRow[];
  const n = (k: string) => h.filter((r) => r.kind === k).length;
  console.log(`Healer stalemate probe — the maximal healer turtle (4 healers + 4 sturdiest, all L5, stone, 6 heaviest traps) × ${top.length} parties of the top two bands × 4 regions`);
  console.log(`  held ${n("caravan_held")}, stalemate ${n("stalemate")} (${pct(share(n("stalemate"), h.length))}), overrun ${n("caravan_overrun")} of ${h.length}; healing offset ${pct(share(h.reduce((s, r) => s + r.healed, 0), h.reduce((s, r) => s + r.taken, 0)))}`);
  console.log(`  stalemate farming ${share(n("stalemate"), h.length) < STALEMATE_FARM_MAX ? "NOT reachable" : "REACHABLE"} (bar: < ${pct(STALEMATE_FARM_MAX)} of the turtle's fights end at the tick cap)`);
  const worst = Math.max(...b.map((r) => r.worstShare));
  const cap = TUNABLES.FENCE_HIT_SEGMENT_CAP / FIXED_ONE;
  console.log(`Structure-breaker stacking probe — ${breakers.length} breaker types × L1–5 × counter siege on/off × ${CONTENT.fences.length} tiers = ${b.length} fights`);
  console.log(`  worst share of one segment taken by one unit in one tick: ${(100 * worst).toFixed(1)}% (cap ${(100 * cap).toFixed(0)}%) — ${worst <= cap + 1e-9 ? "within the cap" : "OVER THE CAP"}; fights that broke a segment: ${b.filter((r) => r.broke).length}/${b.length}`);
}
