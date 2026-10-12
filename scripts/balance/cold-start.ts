/**
 * The band-0 cold-start raider cap (final play-test review S1, COLD_START_RAIDER_CAP_BANDS),
 * re-checked: a rebuilt caravan of 1–4 unmerged starter units, searched for encounter 1 at
 * REPUTATION_START (band 0) from the authored pool, as the server serves it — with the cap
 * (`coldStartRaiderCap` on the pool before `selectCandidates`) and without it. The guide's pick
 * (fewest raiders) is fought with the guided layout and with the best of the skilled set.
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/cold-start.ts [--seeds 25]
 *
 * Pure resolver fights through the server's own adapter path (sweep.ts), deterministic.
 */
import { REGION_IDS, TUNABLES, type RegionId } from "../../packages/content/src/index.js";
import { candidateSeed, coldStartRaiderCap, escalatedCentre, selectCandidates } from "../../apps/server/src/matchmaking/band.js";
import { GUIDED, SKILLED, authoredParties, bestFight, guidePick, manifestOf, oneFight, pct, share, starterTypes, type RosterSpec, type ServedParty } from "./sweep.js";

const si = process.argv.indexOf("--seeds");
const SEEDS = si >= 0 ? Number(process.argv[si + 1]) : 25;
const parties = authoredParties();
const byId = new Map(parties.map((p) => [p.pool.partyId, p] as const));

function rebuilt(regionId: RegionId, size: number): RosterSpec {
  const types = starterTypes(regionId);
  const units = Array.from({ length: size }, (_, i) => ({ typeId: types[i % types.length]!, mergeLevel: 1 }));
  return { label: `${regionId} ×${size}`, regionId, units, traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: TUNABLES.FENCE_MATERIAL_BUDGET } };
}

function menu(seedId: string, packed: number, capped: boolean): ServedParty[] {
  const centre = escalatedCentre(TUNABLES.REPUTATION_START, 1);
  const counted = parties.map((p) => ({ ...p.pool, raiders: p.party.units.length }));
  const cap = capped ? coldStartRaiderCap(counted, centre, packed) : null;
  const out = new Set(cap?.excludedPartyIds ?? []);
  const pool = counted.filter((e) => !out.has(e.partyId)).map(({ raiders: _r, ...e }) => e);
  const r = selectCandidates({ centre, seed: candidateSeed(seedId, `${seedId}-trip`, 1, 1), pool });
  return r.picks.map((p) => byId.get(p.partyId)!);
}

const cache = new Map<string, { guided: boolean; skilled: boolean }>();
function outcome(roster: RosterSpec, sp: ServedParty): { guided: boolean; skilled: boolean } {
  const key = `${roster.label}|${sp.pool.partyId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = manifestOf(roster);
  const g = oneFight(m, sp, GUIDED);
  const s = bestFight(m, sp, SKILLED);
  const res = { guided: !!g && g.kind !== "caravan_overrun", skilled: !!s && s.kind !== "caravan_overrun" };
  cache.set(key, res);
  return res;
}

console.log(`Cold-start raider cap — encounter 1 at REPUTATION_START ${TUNABLES.REPUTATION_START} (centre ${escalatedCentre(TUNABLES.REPUTATION_START, 1)}, band 0), ${SEEDS} seeds × ${REGION_IDS.length} regions; the guide's pick; unmerged starters, 1 Spike Pit, a full Brush Pile budget`);
console.log(`${"packed".padEnd(8)}${"cap".padEnd(6)}${"raiders faced".padEnd(16)}${"guided held".padStart(12)}${"skilled held".padStart(14)}`);
for (const size of [1, 2, 3, 4]) {
  for (const capped of [false, true]) {
    let n = 0;
    let g = 0;
    let s = 0;
    const raiders: number[] = [];
    for (const r of REGION_IDS) {
      const roster = rebuilt(r, size);
      for (let seed = 1; seed <= SEEDS; seed++) {
        const pick = guidePick(menu(`cold-${r}-${size}-${seed}`, size, capped));
        raiders.push(pick.party.units.length);
        const o = outcome(roster, pick);
        n++;
        if (o.guided) g++;
        if (o.skilled) s++;
      }
    }
    const mean = raiders.reduce((a, b) => a + b, 0) / raiders.length;
    console.log(`${String(size).padEnd(8)}${(capped ? "on" : "off").padEnd(6)}${`${Math.min(...raiders)}–${Math.max(...raiders)} (mean ${mean.toFixed(1)})`.padEnd(16)}${pct(share(g, n)).padStart(12)}${pct(share(s, n)).padStart(14)}`);
  }
}
