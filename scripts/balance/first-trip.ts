/**
 * The first-trip probe (chunk 24 QA D1's acceptance): a fresh account's first trip, as the
 * server serves it and as the onboarding guide walks it.
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/first-trip.ts [--seeds 25] [--traps 1] [--jobs 4] [--reserve N]
 *
 * For every region and every possible first refugee claim (the guide takes one from the free
 * menu, which draws from the starting types), `--seeds` distinct caravans (each a different
 * matchmaking seed, as distinct caravan / trip ids give in production):
 *   - the caravan's roster is STARTING_ROSTER (one level-1 unit per starter type by default)
 *     plus that refugee; it packs every unit but `--reserve` (default TUNABLES.GUIDE_RESERVE: the
 *     guide leaves that many in town since the final play-test review S1; `--reserve 0` packs
 *     everything, as before), `--traps` of its starting trap type and the full fence budget of
 *     its starting tier — what the guide's outfit step says. The guide keeps the highest merge
 *     levels and breaks ties by instance id, which is random in production: here the units left
 *     home are rotated by the seed, so every starter mix is sampled;
 *   - encounter 1 is searched at REPUTATION_START + FIRST_ENCOUNTER_CENTRE_OFFSET over the
 *     authored pool (a cold start: no live parties), through the server's own selectCandidates;
 *   - the guide's pick (fewest raiders, least HP) is fought with the guided arrangement;
 *   - on a hold, encounter 2 is searched at the rating the fight left, the player picks the
 *     same way, and arranges it FREELY: reported both for the guide's shape again (a sensible
 *     free layout for someone who just learned it) and for the best of the skilled search set.
 * Printed: the bands actually searched, hold rates at each encounter, and the parties served.
 */
import { REGION_IDS, TUNABLES } from "../../packages/content/src/index.js";
import { bandOf, escalatedCentre } from "../../apps/server/src/matchmaking/band.js";
import { reputationDelta } from "../../apps/server/src/progression/reputation.js";
import { runParallel, serveIfChild } from "./parallel.js";
import { GUIDED, SKILLED, authoredParties, bestFight, freshRoster, guidePick, isRangedOnly, manifestOf, oneFight, pct, raisedStarterParty, servedMenu, share, starterTypes, type Kind, type Layout } from "./sweep.js";

export interface FirstTripTask {
  readonly region: (typeof REGION_IDS)[number];
  readonly refugee: string;
  readonly seed: number;
  readonly traps: number;
  readonly reserve: number;
}
export interface FirstTripResult {
  readonly band1: number;
  readonly party1: string;
  readonly kind1: Kind;
  readonly endTick1: number;
  readonly band2: number | null;
  readonly kind2Guided: Kind | null;
  readonly kind2Best: Kind | null;
  readonly party2: string | null;
}

export function firstTrip(t: FirstTripTask): FirstTripResult {
  const full = freshRoster(t.region, t.refugee, t.traps);
  const keep = Math.max(1, Math.min(TUNABLES.DEPLOYMENT_SLOT_CAP, full.units.length - t.reserve));
  const rot = t.seed % full.units.length;
  const rotated = [...full.units.slice(rot), ...full.units.slice(0, rot)];
  const roster = { ...full, label: `${full.label} packs ${keep}`, units: rotated.slice(0, keep) };
  const m = manifestOf(roster);
  const id = `${t.region}-${t.refugee}-${t.seed}`;
  const rating = TUNABLES.REPUTATION_START;
  const e1 = servedMenu(`caravan-${id}`, `trip-${id}`, rating, 1);
  const p1 = guidePick(e1.menu);
  const r1 = oneFight(m, p1, GUIDED);
  if (!r1) throw new Error(`guided layout refused for ${roster.label}`);
  const base = { band1: bandOf(e1.centre).index, party1: p1.spec.outfit.name, kind1: r1.kind, endTick1: r1.endTick };
  if (r1.kind === "caravan_overrun") return { ...base, band2: null, kind2Guided: null, kind2Best: null, party2: null };
  const rating2 = rating + reputationDelta("caravan", r1.kind, rating, p1.spec.rating).delta;
  const e2 = servedMenu(`caravan-${id}`, `trip-${id}`, rating2, 2);
  const p2 = guidePick(e2.menu);
  const g2 = oneFight(r1.survivors, p2, GUIDED);
  const b2 = bestFight(r1.survivors, p2, SKILLED);
  return { ...base, band2: bandOf(e2.centre).index, kind2Guided: g2?.kind ?? null, kind2Best: b2?.kind ?? null, party2: p2.spec.outfit.name };
}

export function firstTripTasks(seeds: number, traps: number, reserve: number = TUNABLES.GUIDE_RESERVE): FirstTripTask[] {
  const tasks: FirstTripTask[] = [];
  for (const region of REGION_IDS) for (const refugee of starterTypes(region)) for (let seed = 1; seed <= seeds; seed++) tasks.push({ region, refugee, seed, traps, reserve });
  return tasks;
}

// ── Final play-test review r2 S2: the second trip's gate — raised starter parties ─────────────
//
// A caravan's first trip meets authored outfits only (TUNABLES.AUTHORED_ONLY_FIRST_TRIPS), which is
// what firstTrip above measures. From the second trip on, testers' own standing parties are served,
// and a fresh tester's party is what the guide raises: their starters at L1, north edge, `nearest`,
// the free siege. Mountain's and Badlands' starters include ranged units (Trapper, Gunslinger,
// Bounty Hunter). This gate fights each region's raised parties — every pair of its starters (ranged
// pairs included) and the whole starting roster raised — against every fresh guided roster (each
// region × each refugee type, GUIDE_RESERVE left home), the guided layout and the best skilled one.
// Targets (orchestrator, r2 S2): guided ≥ 60 %, best skilled ≥ 70 %, over every region's raised
// parties.

export interface RaisedGateTask {
  readonly raiderRegion: (typeof REGION_IDS)[number];
  readonly label: string;
  readonly typeIds: readonly string[];
  readonly defRegion: (typeof REGION_IDS)[number];
  readonly refugee: string;
  readonly reserve: number;
  /** How many of SKILLED to search (all by default; the CI slice takes fewer). */
  readonly skilled: number;
}
export interface RaisedGateResult {
  readonly raiderRegion: string;
  readonly label: string;
  readonly rangedOnly: boolean;
  readonly guided: Kind;
  readonly best: Kind;
}

/** The raised parties of a region: each pair of its starter types, and the whole starting roster. */
export function raisedParties(region: (typeof REGION_IDS)[number]): { label: string; typeIds: string[] }[] {
  const [a, b] = starterTypes(region) as [string, string];
  const short = (t: string) => t.split(".")[1]!;
  const whole = freshRoster(region, null, 0).units.map((u) => u.typeId);
  return [
    { label: `${region}: ${short(a)} + ${short(a)}`, typeIds: [a, a] },
    { label: `${region}: ${short(a)} + ${short(b)}`, typeIds: [a, b] },
    { label: `${region}: ${short(b)} + ${short(b)}`, typeIds: [b, b] },
    { label: `${region}: the whole starting roster (${whole.length})`, typeIds: whole },
  ];
}

export function raisedGateTasks(reserve: number = TUNABLES.GUIDE_RESERVE, skilled: number = SKILLED.length, defenders?: readonly { region: (typeof REGION_IDS)[number]; refugee: string }[]): RaisedGateTask[] {
  const defs = defenders ?? REGION_IDS.flatMap((region) => starterTypes(region).map((refugee) => ({ region, refugee })));
  const tasks: RaisedGateTask[] = [];
  for (const raiderRegion of REGION_IDS) for (const p of raisedParties(raiderRegion)) for (const d of defs) tasks.push({ raiderRegion, label: p.label, typeIds: p.typeIds, defRegion: d.region, refugee: d.refugee, reserve, skilled });
  return tasks;
}

let templateParty: ReturnType<typeof authoredParties>[number] | undefined;
export function raisedGate(t: RaisedGateTask): RaisedGateResult {
  templateParty ??= authoredParties().find((p) => p.spec.band === 0)!;
  const sp = raisedStarterParty(t.typeIds, t.label, templateParty);
  const full = freshRoster(t.defRegion, t.refugee, 1);
  const keep = Math.max(1, Math.min(TUNABLES.DEPLOYMENT_SLOT_CAP, full.units.length - t.reserve));
  const m = manifestOf({ ...full, units: full.units.slice(0, keep) });
  const g = oneFight(m, sp, GUIDED);
  const layouts: readonly Layout[] = SKILLED.slice(0, t.skilled);
  const b = bestFight(m, sp, layouts);
  if (!g || !b) throw new Error(`a layout was refused for ${t.label} vs ${t.defRegion}`);
  return { raiderRegion: t.raiderRegion, label: t.label, rangedOnly: isRangedOnly(sp.party), guided: g.kind, best: b.kind };
}

export interface RaisedGateSummary {
  readonly fights: number;
  readonly guidedHeld: number;
  readonly bestHeld: number;
  readonly byParty: Record<string, { fights: number; guidedHeld: number; bestHeld: number; rangedOnly: boolean }>;
}
export function summarizeRaised(rs: readonly RaisedGateResult[]): RaisedGateSummary {
  const held = (k: Kind) => k !== "caravan_overrun";
  const byParty: RaisedGateSummary["byParty"] = {};
  for (const r of rs) {
    const e = (byParty[r.label] ??= { fights: 0, guidedHeld: 0, bestHeld: 0, rangedOnly: r.rangedOnly });
    e.fights++;
    if (held(r.guided)) e.guidedHeld++;
    if (held(r.best)) e.bestHeld++;
  }
  return { fights: rs.length, guidedHeld: rs.filter((r) => held(r.guided)).length, bestHeld: rs.filter((r) => held(r.best)).length, byParty };
}

export interface FirstTripSummary {
  readonly fights1: number;
  readonly held1: number;
  readonly stalemate1: number;
  readonly bands1: Record<number, number>;
  readonly reached2: number;
  readonly held2Guided: number;
  readonly held2Best: number;
  readonly bands2: Record<number, number>;
  readonly completed: number;
}

export function summarize(rs: readonly FirstTripResult[]): FirstTripSummary {
  const count = (xs: (number | null)[]) => xs.reduce<Record<number, number>>((a, b) => (b === null ? a : { ...a, [b]: (a[b] ?? 0) + 1 }), {});
  const reached = rs.filter((r) => r.band2 !== null);
  return {
    fights1: rs.length,
    held1: rs.filter((r) => r.kind1 !== "caravan_overrun").length,
    stalemate1: rs.filter((r) => r.kind1 === "stalemate").length,
    bands1: count(rs.map((r) => r.band1)),
    reached2: reached.length,
    held2Guided: reached.filter((r) => r.kind2Guided !== null && r.kind2Guided !== "caravan_overrun").length,
    held2Best: reached.filter((r) => r.kind2Best !== null && r.kind2Best !== "caravan_overrun").length,
    bands2: count(reached.map((r) => r.band2)),
    completed: reached.filter((r) => r.kind2Guided !== null && r.kind2Guided !== "caravan_overrun").length,
  };
}

const isMain = process.argv[1]?.endsWith("first-trip.ts") ?? false;
const raisedMode = process.argv.includes("--raised");
if (isMain && raisedMode && !serveIfChild(raisedGate)) {
  const ji = process.argv.indexOf("--jobs");
  const jobs = ji >= 0 ? Number(process.argv[ji + 1]) : 4;
  const ri = process.argv.indexOf("--reserve");
  const reserve = ri >= 0 ? Number(process.argv[ri + 1]) : TUNABLES.GUIDE_RESERVE;
  const tasks = raisedGateTasks(reserve);
  const rs = await runParallel(process.argv[1]!, tasks, raisedGate, jobs);
  const s = summarizeRaised(rs);
  console.log(`Second-trip gate (r2 S2) — raised starter parties (L1, north, nearest, Battering Wagon) vs every fresh guided roster (reserve ${reserve}); best of ${SKILLED.length} skilled layouts`);
  for (const [label, e] of Object.entries(s.byParty)) console.log(`  ${label.padEnd(48)}${e.rangedOnly ? " ranged" : "       "}  guided ${pct(share(e.guidedHeld, e.fights)).padStart(5)}   best skilled ${pct(share(e.bestHeld, e.fights)).padStart(5)}   (${e.fights})`);
  console.log(`ALL raised parties: guided held ${s.guidedHeld}/${s.fights} = ${pct(share(s.guidedHeld, s.fights))} (target ≥ 60 %)   best skilled held ${s.bestHeld}/${s.fights} = ${pct(share(s.bestHeld, s.fights))} (target ≥ 70 %)`);
}
if (isMain && !raisedMode && !serveIfChild(firstTrip)) {
  const arg = (n: string, d: number) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? Number(process.argv[i + 1]) : d;
  };
  const seeds = arg("seeds", 25);
  const traps = arg("traps", 1);
  const reserve = arg("reserve", TUNABLES.GUIDE_RESERVE);
  const tasks = firstTripTasks(seeds, traps, reserve);
  const rs = await runParallel(process.argv[1]!, tasks, firstTrip, arg("jobs", 4));
  const s = summarize(rs);
  console.log(`First-trip probe — REPUTATION_START ${TUNABLES.REPUTATION_START}, FIRST_ENCOUNTER_CENTRE_OFFSET ${TUNABLES.FIRST_ENCOUNTER_CENTRE_OFFSET} → encounter 1 centre ${escalatedCentre(TUNABLES.REPUTATION_START, 1)}; ${traps} trap(s) packed`);
  console.log(`roster: STARTING_ROSTER model + one refugee, ${reserve} left in town (GUIDE_RESERVE ${TUNABLES.GUIDE_RESERVE}); ${tasks.length} fresh caravans (4 regions × each refugee type × ${seeds} seeds)`);
  console.log(`encounter 1 (guided):   bands searched ${JSON.stringify(s.bands1)}   held ${s.held1}/${s.fights1} = ${pct(share(s.held1, s.fights1))} (stalemates ${s.stalemate1})`);
  console.log(`encounter 2 (free):     bands searched ${JSON.stringify(s.bands2)}   guided shape held ${s.held2Guided}/${s.reached2} = ${pct(share(s.held2Guided, s.reached2))}   skilled best held ${s.held2Best}/${s.reached2} = ${pct(share(s.held2Best, s.reached2))}`);
  console.log(`first trip completed (two holds, then bank): ${s.completed}/${s.fights1} = ${pct(share(s.completed, s.fights1))}`);
  const parties = new Map<string, { n: number; held: number }>();
  for (const r of rs) {
    const e = parties.get(r.party1) ?? { n: 0, held: 0 };
    parties.set(r.party1, { n: e.n + 1, held: e.held + (r.kind1 !== "caravan_overrun" ? 1 : 0) });
  }
  console.log("guide's pick at encounter 1: " + [...parties.entries()].sort().map(([k, v]) => `${k} ${v.held}/${v.n}`).join(", "));
}
