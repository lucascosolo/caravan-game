/**
 * The full matchup sweep (PHASE-2 §37). Every authored party against the defending corpus, then
 * trips at each band, then the analyses the balance pass reads:
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/matchup-sweep.ts [--quick] [--jobs 2] [--seeds 4] [--json out.json]
 *
 *   --quick   desert + mountain, the "defensive" composition only (the tuning loop);
 *             default: all four regions, "defensive" and "mixed" compositions (the record).
 *
 * The corpus, per region: the fresh caravan (STARTING_ROSTER + one refugee, six traps) and the
 * band-typical roster of every band ordinal 0–7 (merge levels 1, 1, 2, 2, 3, 3, 4, 5 — sweep.ts
 * `bandTypicalRoster`). Against every party: the BEST of the skilled set (a skilled player's
 * reading of the scout), the guided arrangement, and the best of the naive layouts.
 *
 * Printed: the outcome matrix (held share by band × roster, per family), stalemate rate, fight
 * length, depth distribution of held fights, owner income per served encounter (loot on holds
 * vs the overrun transfer + party win), presence flags (a unit, trap, siege piece, ability or
 * stance pattern whose presence moves the hold rate by more than FLAG_THRESHOLD within a band),
 * hold rate by encounter index on pushed trips (skilled and naive), and each roster's
 * equilibrium band (the highest band whose encounter-1 hold rate is at least the Reputation
 * break-even, REPUTATION_CARAVAN_OVERRUN / (that + REPUTATION_CARAVAN_HELD)).
 * Deterministic: the same content gives the same tables, whatever --jobs is.
 */
import { writeFileSync } from "node:fs";
import { CONTENT, REGION_IDS, TUNABLES, getUnitType, type RegionId } from "../../packages/content/src/index.js";
import { coinForEncounter } from "../../apps/server/src/economy/coin.js";
import { bandCentre } from "../../apps/server/src/matchmaking/band.js";
import { partyLoot } from "../../apps/server/src/trip/loot.js";
import { runParallel, serveIfChild } from "./parallel.js";
import {
  GUIDED,
  NAIVE,
  SKILLED,
  authoredParties,
  bandTypicalRoster,
  bestFight,
  freshRoster,
  layoutNamed,
  manifestOf,
  median,
  oneFight,
  pct,
  runTrip,
  share,
  starterTypes,
  type Kind,
  type RosterSpec,
} from "./sweep.js";

/** Tunable (chunk 37): a feature is flagged when its presence moves the within-band hold rate by more than this. */
export const FLAG_THRESHOLD = 0.25;
/** A trip pushes until an overrun or this many encounters survived. */
export const TRIP_MAX_ENCOUNTERS = 5;
/** Layouts the trip search uses: the most-often-best of the matrix (keeps trips affordable). */
export const TRIP_LAYOUTS = 24;

export interface Corpus {
  readonly regions: readonly RegionId[];
  readonly rosters: readonly RosterSpec[];
}

export function corpus(quick: boolean): Corpus {
  const regions: RegionId[] = quick ? ["desert", "mountain"] : [...REGION_IDS];
  const comps = quick ? (["defensive"] as const) : (["defensive", "mixed"] as const);
  const rosters: RosterSpec[] = [];
  for (const r of regions) {
    rosters.push({ ...freshRoster(r, starterTypes(r)[1]!, TUNABLES.TRAP_SLOT_CAP), label: `fresh ${r}` });
    for (const c of comps) for (let o = 0; o < 8; o++) rosters.push(bandTypicalRoster(r, o, c));
  }
  return { regions, rosters };
}

export interface MatchTask {
  readonly kind: "match";
  readonly roster: RosterSpec;
  readonly party: number;
}
export interface TripTask {
  readonly kind: "trip";
  readonly roster: RosterSpec;
  readonly band: number;
  readonly seed: number;
  readonly layouts: readonly string[];
  readonly naive: boolean;
}
export type Task = MatchTask | TripTask;

export interface MatchRow {
  readonly band: number;
  readonly party: string;
  readonly kind: Kind;
  readonly depth: number;
  readonly endTick: number;
  readonly layout: string;
  readonly hpLeft: number;
  readonly deaths: number;
  readonly guided: Kind;
  readonly naive: Kind;
  readonly breakerFires: number;
  readonly healed: number;
  readonly postDamageTaken: number;
}
export interface TripRow {
  readonly kinds: Kind[];
  readonly deaths: number[];
}

export function work(t: Task): MatchRow | TripRow {
  if (t.kind === "match") {
    const sp = authoredParties()[t.party]!;
    const m = manifestOf(t.roster);
    const s = bestFight(m, sp, SKILLED)!;
    const g = oneFight(m, sp, GUIDED);
    const n = bestFight(m, sp, NAIVE)!;
    return { band: sp.spec.band, party: sp.spec.username, kind: s.kind, depth: s.depth, endTick: s.endTick, layout: s.layout, hpLeft: s.hpLeft, deaths: s.deaths, guided: g?.kind ?? "caravan_overrun", naive: n.kind, breakerFires: s.breakerFires, healed: s.healed, postDamageTaken: s.postDamageTaken };
  }
  const ls = t.naive ? NAIVE : t.layouts.map(layoutNamed);
  const trip = runTrip(t.roster, bandCentre(t.band), `${t.roster.label}-${t.band}-${t.seed}`, ls, t.naive ? "first" : "best", TRIP_MAX_ENCOUNTERS);
  return { kinds: trip.steps.map((s) => s.result.kind), deaths: trip.steps.map((s) => s.result.deaths) };
}

const held = (k: Kind) => k !== "caravan_overrun";

export interface SweepReport {
  readonly lines: string[];
  readonly matrix: Record<string, Record<number, number>>;
  readonly tripCurves: Record<number, { skilled: number[]; naive: number[]; deathsPerHeld: number }>;
  readonly firstFightGuided: number;
}

export async function sweep(opts: { quick: boolean; diag?: boolean; trips?: boolean; jobs: number; seeds: number; script: string }): Promise<SweepReport> {
  const { rosters } = corpus(opts.quick);
  const parties = authoredParties();
  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  const matchTasks: MatchTask[] = [];
  // --diag (the tuning loop): only each band-typical roster against its own band.
  const onDiagonal = (roster: RosterSpec, band: number) => !opts.diag || roster.label.startsWith(`b${band}-typical`);
  rosters.forEach((roster) => parties.forEach((p, party) => onDiagonal(roster, p.spec.band) && matchTasks.push({ kind: "match", roster, party })));
  const rows = (await runParallel(opts.script, matchTasks, work, opts.jobs)) as MatchRow[];
  const bands = [...new Set(parties.map((p) => p.spec.band))].sort((a, b) => a - b);
  const rosterKey = (r: RosterSpec) => r.label.replace(/ (desert|high_plains|mountain|badlands)/, "");
  const keys = [...new Set(rosters.map(rosterKey))];
  const matrix: Record<string, Record<number, number>> = {};

  out(`Matchup sweep — ${rosters.length} rosters × ${parties.length} authored parties = ${rows.length} matchups; skilled = best of ${SKILLED.length} layouts`);
  for (const fam of ["kind", "guided", "naive"] as const) {
    out("");
    out(`Held share (held or stalemate) — ${fam === "kind" ? "SKILLED (best of the search set)" : fam === "guided" ? "GUIDED (the onboarding arrangement)" : "NAIVE (best of three scout-blind layouts)"}`);
    out("roster".padEnd(26) + bands.map((b) => `b${b}`.padStart(6)).join(""));
    for (const k of keys) {
      const row = bands.map((b) => {
        const xs = rows.filter((r, i) => rosterKey(matchTasks[i]!.roster) === k && r.band === b);
        const v = share(xs.filter((r) => held(r[fam])).length, xs.length);
        if (fam === "kind") (matrix[k] ??= {})[b] = v;
        return pct(v).padStart(6);
      });
      out(k.padEnd(26) + row.join(""));
    }
  }

  // Band-typical diagonal: roster bN vs band N.
  out("");
  out("Band-typical roster at its own band (skilled / guided / naive): " + bands.map((b) => {
    const xs = rows.filter((r, i) => matchTasks[i]!.roster.label.startsWith(`b${b}-typical`) && r.band === b);
    return `b${b} ${pct(share(xs.filter((r) => held(r.kind)).length, xs.length))}/${pct(share(xs.filter((r) => held(r.guided)).length, xs.length))}/${pct(share(xs.filter((r) => held(r.naive)).length, xs.length))}`;
  }).join("  "));

  // Outcome kinds, fight length, depth.
  const stalemates = rows.filter((r) => r.kind === "stalemate").length;
  const secs = rows.map((r) => (r.endTick + 1) / TUNABLES.TICK_RATE);
  const sorted = [...secs].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  out("");
  out(`Outcomes (skilled): held ${rows.filter((r) => r.kind === "caravan_held").length}, stalemate ${stalemates} (${pct(share(stalemates, rows.length))}), overrun ${rows.filter((r) => r.kind === "caravan_overrun").length}`);
  out(`Fight length (skilled, s): p10 ${q(0.1).toFixed(1)}, median ${median(secs).toFixed(1)}, p90 ${q(0.9).toFixed(1)}; in 20–90 s ${pct(share(secs.filter((s) => s >= 20 && s <= 90).length, secs.length))}`);
  const heldRows = rows.filter((r) => r.kind === "caravan_held");
  const hist = [0, 0, 0, 0, 0];
  for (const r of heldRows) hist[r.depth === 0 ? 0 : Math.min(4, 1 + Math.floor((4 * r.depth) / 1024))]!++;
  out(`Depth of held fights: 0 (never crossed the ring) ${hist[0]}, 1–25% ${hist[1]}, 25–50% ${hist[2]}, 50–75% ${hist[3]}, 75–100% ${hist[4]} (of ${heldRows.length})`);
  const healed = rows.reduce((s, r) => s + r.healed, 0);
  const taken = rows.reduce((s, r) => s + r.postDamageTaken, 0);
  out(`Healing offset over the corpus: ${pct(share(healed, taken))} of damage posts took was healed`);

  // Owner income per served encounter at encounter 1 (a player owner; authored owners are paid nothing).
  const loot = heldRows.map((r) => partyLoot("caravan_held", r.depth, coinForEncounter(1, r.band)));
  const over = rows.filter((r) => r.kind === "caravan_overrun").map((r) => coinForEncounter(1, r.band) + TUNABLES.COIN_PER_PARTY_WIN);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  out(`Owner income per served encounter (encounter 1, as if player-owned): held fights pay depth loot, mean ${Math.round(sum(loot) / Math.max(1, loot.length))} (${pct(share(sum(loot), sum(loot) + sum(over)))} of all owner income); overruns pay transfer + party win, mean ${Math.round(sum(over) / Math.max(1, over.length))}`);

  // By party region and stance pattern (the confounders of the flags below).
  out("");
  for (const [label, keyOf] of [["party region", (i: number) => parties[matchTasks[i]!.party]!.spec.regionId], ["stance pattern", (i: number) => parties[matchTasks[i]!.party]!.spec.stancePattern]] as const) {
    const ks = [...new Set(rows.map((_, i) => keyOf(i)))].sort();
    out(`Held share (skilled) by ${label} × band: ` + ks.map((k) => `${k} ` + bands.map((b) => {
      const xs = rows.filter((r, i) => keyOf(i) === k && r.band === b);
      return xs.length ? pct(share(xs.filter((r) => held(r.kind)).length, xs.length)) : "–";
    }).join("/")).join("   "));
  }

  // Presence flags.
  out("");
  out(`Presence flags (|Δ hold rate| within band > ${FLAG_THRESHOLD}, band-weighted; attacker features over parties, defender features over rosters):`);
  const feats = new Map<string, (i: number) => boolean>();
  const partyOf = (i: number) => parties[matchTasks[i]!.party]!;
  for (const u of CONTENT.units) {
    feats.set(`raider ${u.id}`, (i) => partyOf(i).party.units.some((x) => x.typeId === u.id));
    feats.set(`post ${u.id}`, (i) => matchTasks[i]!.roster.units.some((x) => x.typeId === u.id));
  }
  for (const s of CONTENT.siege) feats.set(`siege ${s.id}`, (i) => partyOf(i).spec.siege.includes(s.id));
  for (const t of CONTENT.traps) feats.set(`trap ${t.id}`, (i) => matchTasks[i]!.roster.traps.includes(t.id));
  for (const a of ["burst_radius", "heavy_strike", "heal_radius", "self_buff", "dash", "structure_breaker"]) {
    feats.set(`raider ability ${a}`, (i) => partyOf(i).party.units.some((x) => getUnitType(x.typeId)!.ability.archetype === a));
    feats.set(`post ability ${a}`, (i) => matchTasks[i]!.roster.units.some((x) => getUnitType(x.typeId)!.ability.archetype === a));
  }
  for (const p of ["nearest", "traps", "core", "mixed"]) feats.set(`stance pattern ${p}`, (i) => partyOf(i).spec.stancePattern === p);
  const flags: string[] = [];
  const deltas: [string, number][] = [];
  for (const [name, has] of feats) {
    let wsum = 0;
    let dsum = 0;
    for (const b of bands) {
      const idx = rows.map((_, i) => i).filter((i) => rows[i]!.band === b);
      const yes = idx.filter(has);
      const no = idx.filter((i) => !has(i));
      if (yes.length < 4 || no.length < 4) continue;
      const w = Math.min(yes.length, no.length);
      dsum += w * (share(yes.filter((i) => held(rows[i]!.kind)).length, yes.length) - share(no.filter((i) => held(rows[i]!.kind)).length, no.length));
      wsum += w;
    }
    if (wsum === 0) continue;
    const d = dsum / wsum;
    deltas.push([name, d]);
    if (Math.abs(d) > FLAG_THRESHOLD) flags.push(`${name} ${d > 0 ? "+" : ""}${(100 * d).toFixed(0)} pts`);
  }
  out(flags.length ? "  FLAGGED: " + flags.join("; ") : "  none flagged");
  deltas.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  out("  largest: " + deltas.slice(0, 8).map(([n, d]) => `${n} ${d > 0 ? "+" : ""}${(100 * d).toFixed(0)}`).join(", "));

  // Trips: hold rate by encounter index, band-typical roster at its band centre, skilled vs naive.
  const wins = new Map<string, number>();
  for (const r of rows) if (held(r.kind)) wins.set(r.layout, (wins.get(r.layout) ?? 0) + 1);
  const tripLayouts = [...wins.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TRIP_LAYOUTS).map(([n]) => n);
  if (tripLayouts.length === 0) tripLayouts.push(GUIDED.name);
  out("");
  out(`Most-often-best layouts: ${[...wins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n} ${c}`).join(", ")}`);
  const tripTasks: TripTask[] = [];
  if (opts.trips === false) return { lines, matrix, tripCurves: {}, firstFightGuided: NaN };
  const typicalOf = (r: RegionId, b: number) => rosters.find((x) => x.label === `b${b}-typical ${r} defensive`)!;
  for (const r of opts.quick ? (["desert", "mountain"] as RegionId[]) : [...REGION_IDS]) for (const b of bands) for (let seed = 1; seed <= opts.seeds; seed++) for (const naive of [false, true]) tripTasks.push({ kind: "trip", roster: typicalOf(r, b), band: b, seed, layouts: tripLayouts, naive });
  const trips = (await runParallel(opts.script, tripTasks, work, opts.jobs)) as TripRow[];
  const tripCurves: SweepReport["tripCurves"] = {};
  out(`Pushed trips (band-typical roster from its band centre, push until overrun or ${TRIP_MAX_ENCOUNTERS}): hold rate at encounter j given reached — skilled | naive; deaths per held encounter (skilled)`);
  for (const b of bands) {
    const curve = (naive: boolean) => {
      const ts = trips.filter((_, i) => tripTasks[i]!.band === b && tripTasks[i]!.naive === naive);
      return Array.from({ length: TRIP_MAX_ENCOUNTERS }, (_, j) => {
        const reached = ts.filter((t) => t.kinds.length > j);
        return reached.length === 0 ? NaN : share(reached.filter((t) => held(t.kinds[j]!)).length, reached.length);
      });
    };
    const ts = trips.filter((_, i) => tripTasks[i]!.band === b && !tripTasks[i]!.naive);
    let hd = 0;
    let hn = 0;
    for (const t of ts) t.kinds.forEach((k, j) => {
      if (held(k)) {
        hd += t.deaths[j]!;
        hn++;
      }
    });
    const s = curve(false);
    const n = curve(true);
    tripCurves[b] = { skilled: s, naive: n, deathsPerHeld: share(hd, hn) };
    const f = (xs: number[]) => xs.map((x) => (Number.isNaN(x) ? "  –" : pct(x).padStart(4))).join(" ");
    out(`  b${b}: ${f(s)} | ${f(n)}   deaths/held ${share(hd, hn).toFixed(2)}`);
  }

  // Equilibrium: the highest band whose encounter-1 hold rate clears the Reputation break-even.
  const breakEven = -TUNABLES.REPUTATION_CARAVAN_OVERRUN / (TUNABLES.REPUTATION_CARAVAN_HELD - TUNABLES.REPUTATION_CARAVAN_OVERRUN);
  out("");
  out(`Equilibrium band (highest band with skilled encounter-1 hold ≥ ${pct(breakEven)}): ` + keys.map((k) => `${k}: ${bands.filter((b) => (matrix[k]?.[b] ?? 0) >= breakEven).pop() ?? "below 0"}`).join(", "));
  const guidedFresh = rows.filter((r, i) => matchTasks[i]!.roster.label.startsWith("fresh") && r.band === 0);
  return { lines, matrix, tripCurves, firstFightGuided: share(guidedFresh.filter((r) => held(r.guided)).length, guidedFresh.length) };
}

const isMain = process.argv[1]?.endsWith("matchup-sweep.ts") ?? false;
if (isMain && !serveIfChild(work)) {
  const arg = (n: string, d: number) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? Number(process.argv[i + 1]) : d;
  };
  const t0 = Date.now();
  const report = await sweep({ quick: process.argv.includes("--quick"), diag: process.argv.includes("--diag"), trips: !process.argv.includes("--no-trips"), jobs: arg("jobs", 2), seeds: arg("seeds", 4), script: process.argv[1]! });
  for (const l of report.lines) console.log(l);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const j = process.argv.indexOf("--json");
  if (j >= 0) writeFileSync(process.argv[j + 1]!, JSON.stringify({ matrix: report.matrix, tripCurves: report.tripCurves }, null, 1));
}
