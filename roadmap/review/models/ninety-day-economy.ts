/**
 * 90-day economy + progression simulation (studio live-ops review). OFFLINE, floats allowed,
 * nothing here reaches the game. Uses the repo's real tunables and earn math
 * (coinForEncounter / coinForDelivery / bandOf), the real ladder and unlock tables and web
 * shapes, and resolver-MEASURED hold curves from a matchup-sweep --json file.
 *
 *   pnpm --filter @caravan/server exec tsx <this> <sweep.json> [--players 300] [--json out.json]
 *
 * Model (stated, every number below is an assumption to argue with):
 *  - Persona: trips/day, refugee claims/day (one free menu per session at most), strikes/day
 *    the player's standing party receives (passive side), a skill gap subtracted from the
 *    sweep's SKILLED hold rate (best of 76 layouts), a bank policy, a spending style.
 *  - Hold rate at encounter j for a circle of mean merge level L at display band B:
 *    matrix[row(L)][B] × (tripCurve[B].skilled[j] / tripCurve[B].skilled[1]) − skillGap.
 *    row(L) = the band-typical roster whose units are level L (L1 b1, L2 b3, L3 b5, L4 b6, L5 b7).
 *  - Deaths per held encounter: tripCurve[B].deathsPerHeld (Poisson). An overrun: each living
 *    packed unit dies in the fight with finalFightDeathShare (de-merged), the rest are destroyed.
 *  - Reputation: +REPUTATION_CARAVAN_HELD / REPUTATION_CARAVAN_OVERRUN, no gap scaling, floor.
 *  - Ladders: living and trap both +25 a hold / +10 an overrun (traps are free to pack, so every
 *    circle uses the trap pool); siege only from the party's strikes (+30 overrun, +10 held).
 *  - Trickle 200/h credited per hour of the day while below the cap; what the cap swallows is
 *    counted as "idle loss" (the server writes nothing for it).
 *  - Passive strike income: held strike = depth loot (sweep-measured mean 505 at the corpus),
 *    overrun = transfer + COIN_PER_PARTY_WIN (measured mean 1,777); overrun share 28 %.
 *  - Spending styles: "natural" merges only refugee copies, buys mercenaries only to keep 8 units
 *    to pack; "spender" also buys mercenaries to complete merges toward the target level, keeping
 *    a 2,000 buffer. Merges never take the roster below 8 (D4 of round 2: a merge under 8 lowers
 *    what can be packed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { TUNABLES } from "/home/user/caravan-game/.claude/worktrees/agent-a627f488ddfa378c9/packages/content/src/index.ts";
import { coinForDelivery, coinForEncounter } from "/home/user/caravan-game/.claude/worktrees/agent-a627f488ddfa378c9/apps/server/src/economy/coin.ts";
import { bandOf } from "/home/user/caravan-game/.claude/worktrees/agent-a627f488ddfa378c9/apps/server/src/matchmaking/band.ts";

const argv = process.argv.slice(2);
const sweepFile = argv[0]!;
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1]! : d; };
const PLAYERS = Number(opt("players", "300"));
const DAYS = Number(opt("days", "90"));
const sweep = JSON.parse(readFileSync(sweepFile, "utf8")) as { matrix: Record<string, Record<string, number>>; tripCurves: Record<string, { skilled: (number | null)[]; naive: (number | null)[]; deathsPerHeld: number }>; finalFightDeathShare?: number };
const CHOICE = Number(opt("choice", "0.08"));
const GAPSCALE = Number(opt("gapscale", "1"));
const FINAL_SHARE = sweep.finalFightDeathShare ?? 0.4;
const T = TUNABLES as any;
const CAP: number = T.COIN_STORAGE_CAP;
const SLOTS: number = T.DEPLOYMENT_SLOT_CAP;
const RUNGS: number[] = T.LADDER_POINTS_TO_RUNG;
const UPR: number[] = T.UNLOCK_POINTS_BY_RUNG;
const MERGE_COST: number[] = T.MERGE_COST_BY_TARGET_LEVEL;
const MERC: number = T.MERCENARY_COST_BASE;

// ── deterministic PRNG ─────────────────────────────────────────────────────────────────
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function poisson(r: () => number, lambda: number) { let k = 0, p = 1; const L = Math.exp(-lambda); do { k++; p *= r(); } while (p > L); return k - 1; }

// ── hold model ───────────────────────────────────────────────────────────────────────────
const ROW: Record<number, string> = { 1: "b1-typical defensive", 2: "b3-typical defensive", 3: "b5-typical defensive", 4: "b6-typical defensive", 5: "b7-typical defensive" };
function enc1(level: number, band: number): number {
  const lo = Math.max(1, Math.min(5, Math.floor(level))), hi = Math.min(5, lo + 1), f = Math.min(1, Math.max(0, level - lo));
  const at = (l: number) => { const row = sweep.matrix[ROW[l]!]!; const b = Math.min(7, band); return row[String(b)] ?? 0; };
  return at(lo) * (1 - f) + at(hi) * f;
}
function holdRate(level: number, band: number, j: number, gap: number): number {
  const tc = sweep.tripCurves[String(Math.min(7, band))];
  let shape = 1;
  if (tc && j > 1) { const s1 = tc.skilled[0] ?? 1; const sj = tc.skilled[j - 1]; shape = sj == null ? 0 : sj / Math.max(1e-6, s1 ?? 1); }
  const g = gap * (band <= 1 ? 0.25 : 1) * (1 + 0.25 * (j - 1));
  return Math.max(0, Math.min(1, Math.min(1, enc1(level, band) + CHOICE) * shape - g * GAPSCALE));
}
const deathsPerHeld = (band: number) => sweep.tripCurves[String(Math.min(7, band))]?.deathsPerHeld ?? 0.5;

// ── webs (desert shape; every region's living web has the same tiers and prerequisites) ─────
const LIVING_ORDER = [ { id: "C", cost: 1 }, { id: "D", cost: 2 }, { id: "E", cost: 2 }, { id: "F", cost: 8 }, { id: "H", cost: 14 }, { id: "G", cost: 8 } ]; // t1, t2, t2, t3 specialist, t4 capstone, t3 rejoin
const TRAP_ORDER = [1, 1, 3, 3, 7, 7, 7, 10];
function rungOf(points: number) { let r = 0; while (r + 1 < RUNGS.length && points >= RUNGS[r + 1]!) r++; return r; }
function pointsGranted(rung: number) { let s = 0; for (let i = 1; i <= rung; i++) s += UPR[i]!; return s; }

interface Persona { name: string; tripsPerDay: number[]; refugeesPerDay: number; strikesPerDay: number; gap: number; bankAfter: number; target: number; style: "natural" | "spender" }

interface Unit { type: string; level: number; dead?: boolean }
interface DayRow { trips: number; banks: number; overruns: number; encounters: number; trickle: number; tripCoin: number; passive: number; mergeSpend: number; mercSpend: number; idleLoss: number; capDiscard: number; balance: number; level: number; band: number; rung: number; livingNodes: number; trapNodes: number; maxLevel: number; atCap: boolean; demergeLevels: number; destroyed: number; merges: number }

function simulate(p: Persona, seed: number) {
  const r = rng(seed);
  let coin = 0, rating: number = T.REPUTATION_START, livingPts = 0, trapPts = 0, siegePts = 0, livingSpent = 0, trapSpent = 0;
  let unlocked = ["A", "B"]; let livingNodes = 2, trapNodes = 2, banks = 0;
  const roster: Unit[] = [];
  for (const t of ["A", "B"]) for (let i = 0; i < 3; i++) roster.push({ type: t, level: 1 });
  const rows: DayRow[] = [];
  const firsts: Record<string, number | null> = { tier2: null, L3: null, L4: null, L5: null, circle8L3: null, circle8L4: null, rung10: null, rung20: null, band5: null, band7: null, cap: null, webCapped: null };
  const mark = (k: string, d: number) => { if (firsts[k] == null) firsts[k] = d; };
  for (let d = 0; d < DAYS; d++) {
    const row: DayRow = { trips: 0, banks: 0, overruns: 0, encounters: 0, trickle: 0, tripCoin: 0, passive: 0, mergeSpend: 0, mercSpend: 0, idleLoss: 0, capDiscard: 0, balance: 0, level: 0, band: 0, rung: 0, livingNodes: 0, trapNodes: 0, maxLevel: 0, atCap: false, demergeLevels: 0, destroyed: 0, merges: 0 };
    const credit = (amt: number, kind: "tripCoin" | "passive") => { const room = Math.max(0, CAP - coin); const got = Math.min(room, amt); coin += got; row[kind] += got; row.capDiscard += amt - got; };
    // trickle, hour by hour
    for (let h = 0; h < 24; h++) { const add = T.COIN_TRICKLE_RATE_PER_HOUR; const got = Math.min(Math.max(0, CAP - coin), add); coin += got; row.trickle += got; row.idleLoss += add - got; }
    // passive strikes (only once the party is up: from day 0, after the guide's raise)
    const strikes = poisson(r, p.strikesPerDay);
    for (let s = 0; s < strikes; s++) { if (r() < 0.28) { credit(1777, "passive"); siegePts += 30; } else { credit(505, "passive"); siegePts += 10; } }
    // town: refugees (offer 3 from the unlocked pool; pick the type with the most L1 copies on offer)
    const relief = roster.length < T.REFUGEE_ROSTER_FLOOR ? T.REFUGEE_ROSTER_FLOOR - roster.length : 0;
    const claims = Math.floor(p.refugeesPerDay + (r() < p.refugeesPerDay % 1 ? 1 : 0)) + relief;
    for (let c = 0; c < claims; c++) {
      const pool = [...unlocked]; const offer: string[] = [];
      for (let k = 0; k < 3; k++) { if (pool.length) offer.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!); else offer.push(unlocked[Math.floor(r() * unlocked.length)]!); }
      const count = (t: string) => roster.filter((u) => u.type === t && u.level === 1).length;
      offer.sort((a, b) => count(b) - count(a) || (b > a ? 1 : -1));
      roster.push({ type: offer[0]!, level: 1 });
    }
    // unlocks (points are free; buy in the stated order as soon as affordable)
    const lr = rungOf(livingPts), tr = rungOf(trapPts);
    while (livingNodes - 2 < LIVING_ORDER.length) { const n = LIVING_ORDER[livingNodes - 2]!; if (pointsGranted(lr) - livingSpent >= n.cost && livingSpent + n.cost <= 30) { livingSpent += n.cost; livingNodes++; unlocked.push(n.id); if (n.cost >= 2) mark("tier2", d); } else break; }
    if (livingNodes - 2 < LIVING_ORDER.length && livingSpent + LIVING_ORDER[livingNodes - 2]!.cost > 30) mark("webCapped", d);
    while (trapNodes - 2 < TRAP_ORDER.length) { const c = TRAP_ORDER[trapNodes - 2]!; if (pointsGranted(tr) - trapSpent >= c && trapSpent + c <= 30) { trapSpent += c; trapNodes++; } else break; }
    // mercenaries: keep at least SLOTS units to pack (+2 reserve for the spender)
    const want = SLOTS + (p.style === "spender" ? 2 : 0);
    const focus = () => { const by: Record<string, number> = {}; for (const u of roster) by[u.type] = (by[u.type] ?? 0) + 2 ** (u.level - 1); return Object.entries(by).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "A"; };
    while (roster.length < want && coin >= MERC + (p.style === "spender" ? 0 : 1500)) { coin -= MERC; row.mercSpend += MERC; roster.push({ type: focus(), level: 1 }); }
    // merges toward the target level, never below SLOTS units
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let lvl = 1; lvl < p.target; lvl++) {
        const groups: Record<string, Unit[]> = {};
        for (const u of roster) if (u.level === lvl) (groups[u.type] ??= []).push(u);
        const best = Object.entries(groups).sort((a, b) => b[1].length - a[1].length)[0];
        if (!best) continue;
        const [type, us] = best;
        const five = us.length >= 5 && roster.length - 2 >= SLOTS && coin >= 3 * MERGE_COST[lvl + 1]! + 2000 * (p.style === "spender" ? 1 : 0);
        const two = us.length >= 2 && roster.length - 1 >= SLOTS && coin >= MERGE_COST[lvl + 1]!;
        if (five) { for (const u of us.slice(0, 5)) roster.splice(roster.indexOf(u), 1); for (let k = 0; k < 3; k++) roster.push({ type, level: lvl + 1 }); coin -= 3 * MERGE_COST[lvl + 1]!; row.mergeSpend += 3 * MERGE_COST[lvl + 1]!; row.merges++; progressed = true; break; }
        if (two) { for (const u of us.slice(0, 2)) roster.splice(roster.indexOf(u), 1); roster.push({ type, level: lvl + 1 }); coin -= MERGE_COST[lvl + 1]!; row.mergeSpend += MERGE_COST[lvl + 1]!; row.merges++; progressed = true; break; }
      }
      // spender: buy a mercenary to complete a pair at level 1 when Coin is idle
      if (!progressed && p.style === "spender" && coin >= MERC + MERGE_COST[2]! + 2000) {
        const lowest = roster.filter((u) => u.level < p.target).sort((a, b) => a.level - b.level)[0];
        if (lowest) { coin -= MERC; row.mercSpend += MERC; roster.push({ type: focus(), level: 1 }); progressed = true; }
      }
    }
    for (const u of roster) { if (u.level >= 3) mark("L3", d); if (u.level >= 4) mark("L4", d); if (u.level >= 5) mark("L5", d); }
    // trips
    const trips = p.tripsPerDay[d % p.tripsPerDay.length]!;
    for (let t = 0; t < trips; t++) {
      const packN = Math.max(Math.min(roster.length, 5), Math.min(SLOTS, roster.length - (roster.length >= SLOTS + 2 ? 0 : 2)));
      const packed = [...roster].sort((a, b) => b.level - a.level).slice(0, Math.max(1, packN));
      if (!packed.length) break;
      const level = packed.reduce((s, u) => s + u.level, 0) / packed.length;
      const band = bandOf(Math.round(rating)).index;
      let accrued = 0, k = 0, overrun = false; row.trips++;
      for (let j = 1; j <= 8; j++) {
        row.encounters++;
        const ph = holdRate(Math.max(1, level), band, j, p.gap) * Math.min(1, 0.8 + 0.2 * packed.length / SLOTS);
        if (r() < ph) {
          k = j; accrued += coinForEncounter(j, band); rating += T.REPUTATION_CARAVAN_HELD; livingPts += 25; trapPts += 25;
          const deaths = poisson(r, deathsPerHeld(band));
          const alive = packed.filter((u) => !u.dead);
          for (let x = 0; x < deaths && alive.length; x++) alive.splice(Math.floor(r() * alive.length), 1)[0]!.dead = true;
          const anyDead = packed.some((u) => u.dead);
          const deadN = packed.filter((u) => u.dead).length;
          if (j >= p.bankAfter || (p.bankAfter <= 2 ? anyDead : deadN >= 2) || packed.every((u) => u.dead)) break;
        } else { overrun = true; rating = Math.max(T.REPUTATION_FLOOR, rating + T.REPUTATION_CARAVAN_OVERRUN); livingPts += 10; trapPts += 10; break; }
      }
      if (overrun) {
        row.overruns++;
        for (const u of packed) {
          if (!u.dead && r() < FINAL_SHARE) u.dead = true;
          if (!u.dead) { roster.splice(roster.indexOf(u), 1); row.destroyed++; }
        }
      } else { credit(accrued + coinForDelivery(k), "tripCoin"); banks++; row.banks++; }
      for (const u of packed) if (u.dead) { if (u.level > 1) { u.level--; row.demergeLevels++; } delete u.dead; }
    }
    const b = bandOf(Math.round(rating)).index;
    if (b >= 5) mark("band5", d); if (b >= 7) mark("band7", d);
    if (rungOf(livingPts) >= 10) mark("rung10", d); if (rungOf(livingPts) >= 20) mark("rung20", d);
    const top8 = [...roster].sort((a, c) => c.level - a.level).slice(0, SLOTS);
    if (top8.length === SLOTS && top8.every((u) => u.level >= 3)) mark("circle8L3", d);
    if (top8.length === SLOTS && top8.every((u) => u.level >= 4)) mark("circle8L4", d);
    if (coin >= CAP) mark("cap", d);
    Object.assign(row, { balance: coin, level: top8.reduce((s, u) => s + u.level, 0) / Math.max(1, top8.length), band: b, rung: rungOf(livingPts), livingNodes, trapNodes, maxLevel: Math.max(0, ...roster.map((u) => u.level)), atCap: coin >= CAP * 0.9 });
    rows.push(row);
  }
  return { rows, firsts, siegeRung: rungOf(siegePts) };
}

const PERSONAS: Persona[] = [
  // casual: 1–2 sessions a day, ~2.3 trips a day (16 a week), one refugee per session, banks after 2 holds (the guide's habit)
  { name: "casual/natural", tripsPerDay: [2, 3, 2, 2, 3, 2, 2], refugeesPerDay: 1.5, strikesPerDay: 1, gap: 0.12, bankAfter: 2, target: 5, style: "natural" },
  { name: "casual/spender", tripsPerDay: [2, 3, 2, 2, 3, 2, 2], refugeesPerDay: 1.5, strikesPerDay: 1, gap: 0.12, bankAfter: 2, target: 5, style: "spender" },
  // hardcore: 30+ trips a week (35), 4 sessions, pushes to 3 holds, closer to the skilled set
  { name: "hardcore/natural", tripsPerDay: [5], refugeesPerDay: 4, strikesPerDay: 3, gap: 0.06, bankAfter: 3, target: 5, style: "natural" },
  { name: "hardcore/spender", tripsPerDay: [5], refugeesPerDay: 4, strikesPerDay: 3, gap: 0.06, bankAfter: 3, target: 5, style: "spender" },
  // the same hardcore player banking the guide's way (after 2 holds, or at the first death)
  { name: "careful/spender", tripsPerDay: [5], refugeesPerDay: 4, strikesPerDay: 3, gap: 0.06, bankAfter: 2, target: 5, style: "spender" },
  { name: "careful/L3cap", tripsPerDay: [5], refugeesPerDay: 4, strikesPerDay: 3, gap: 0.06, bankAfter: 2, target: 3, style: "spender" },
];
const only = opt("persona", "");
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const pctl = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };
const out: any = {};
for (const p of PERSONAS) {
  if (only && !p.name.startsWith(only)) continue;
  const runs = Array.from({ length: PLAYERS }, (_, i) => simulate(p, 7919 * (i + 1)));
  console.log(`\n=== ${p.name}  (${PLAYERS} players; trips/day ${p.tripsPerDay.join(",")}; refugees/day ${p.refugeesPerDay}; strikes/day ${p.strikesPerDay}; skill gap ${p.gap}; bank after ${p.bankAfter} holds)`);
  console.log("week  trickle/d  trips/d  passive/d | merge/d  merc/d | idleLoss/d capDisc/d | balance p50 (p90) atCap%  | circle lvl  maxLvl band rung  nodes(L/T) demerge/d lost/d");
  const weeks: any[] = [];
  for (let w = 0; w < Math.ceil(DAYS / 7); w++) {
    const days = Array.from({ length: 7 }, (_, i) => w * 7 + i).filter((d) => d < DAYS);
    const avg = (f: (r: DayRow) => number) => runs.reduce((s, run) => s + days.reduce((a, d) => a + f(run.rows[d]!), 0) / days.length, 0) / runs.length;
    const last = days[days.length - 1]!;
    const bal = runs.map((run) => run.rows[last]!.balance);
    const wk = { week: w + 1, trickle: avg((r) => r.trickle), trip: avg((r) => r.tripCoin), passive: avg((r) => r.passive), merge: avg((r) => r.mergeSpend), merc: avg((r) => r.mercSpend), idle: avg((r) => r.idleLoss), capDisc: avg((r) => r.capDiscard), balP50: median(bal), balP90: pctl(bal, 0.9), atCap: runs.filter((run) => run.rows[last]!.atCap).length / runs.length, level: median(runs.map((run) => run.rows[last]!.level)), maxLevel: median(runs.map((run) => run.rows[last]!.maxLevel)), band: median(runs.map((run) => run.rows[last]!.band)), rung: median(runs.map((run) => run.rows[last]!.rung)), livingNodes: median(runs.map((run) => run.rows[last]!.livingNodes)), trapNodes: median(runs.map((run) => run.rows[last]!.trapNodes)), demerge: avg((r) => r.demergeLevels), lost: avg((r) => r.destroyed), bankPct: avg((r) => r.banks) / Math.max(1e-9, avg((r) => r.trips)) };
    weeks.push(wk);
    const f = (n: number) => String(Math.round(n)).padStart(7);
    console.log(`${String(wk.week).padStart(3)} ${f(wk.trickle)}  ${f(wk.trip)} ${f(wk.passive)}   | ${f(wk.merge)} ${f(wk.merc)} | ${f(wk.idle)}   ${f(wk.capDisc)}  | ${f(wk.balP50)} (${f(wk.balP90)}) ${String(Math.round(wk.atCap * 100)).padStart(3)}%  |   ${wk.level.toFixed(2)}     ${wk.maxLevel}    ${wk.band}   ${String(wk.rung).padStart(2)}    ${wk.livingNodes}/${wk.trapNodes}     ${wk.demerge.toFixed(2)}   ${wk.lost.toFixed(2)}  bank ${(100 * wk.bankPct).toFixed(0)}%`);
  }
  const ms: any = {};
  for (const k of Object.keys(runs[0]!.firsts)) {
    const ds = runs.map((run) => run.firsts[k]).filter((x): x is number => x != null);
    ms[k] = { reached: ds.length / runs.length, p25: ds.length ? pctl(ds, 0.25) + 1 : null, median: ds.length ? median(ds) + 1 : null, p75: ds.length ? pctl(ds, 0.75) + 1 : null };
  }
  console.log("milestones (day, 1-based; share of players reaching it within the window):");
  for (const [k, v] of Object.entries(ms) as any) console.log(`  ${k.padEnd(10)} reached ${(100 * v.reached).toFixed(0).padStart(3)}%   p25 ${v.p25 ?? "—"}  median ${v.median ?? "—"}  p75 ${v.p75 ?? "—"}`);
  const tt = (f: (r: DayRow) => number) => runs.reduce((s, run) => s + run.rows.reduce((a, x) => a + f(x), 0), 0);
  console.log(`  trips ${(tt((r) => r.trips) / runs.length).toFixed(0)} per player; banked ${(100 * tt((r) => r.banks) / tt((r) => r.trips)).toFixed(0)}%, overrun ${(100 * tt((r) => r.overruns) / tt((r) => r.trips)).toFixed(0)}%; encounters per trip ${(tt((r) => r.encounters) / tt((r) => r.trips)).toFixed(2)}; banked Coin per banked trip (credited) ${(tt((r) => r.tripCoin) / Math.max(1, tt((r) => r.banks))).toFixed(0)}`);
  console.log(`  siege ladder rung at day ${DAYS} (passive side only): median ${median(runs.map((r) => r.siegeRung))}`);
  const totals = (f: (r: DayRow) => number) => runs.reduce((s, run) => s + run.rows.reduce((a, x) => a + f(x), 0), 0) / runs.length;
  const src = totals((r) => r.trickle + r.tripCoin + r.passive), sink = totals((r) => r.mergeSpend + r.mercSpend);
  console.log(`  90-day totals per player: sources ${Math.round(src)} (trickle ${Math.round(totals((r) => r.trickle))}, trips ${Math.round(totals((r) => r.tripCoin))}, passive ${Math.round(totals((r) => r.passive))}); sinks ${Math.round(sink)} (merge ${Math.round(totals((r) => r.mergeSpend))}, mercenary ${Math.round(totals((r) => r.mercSpend))}); idle trickle lost at the cap ${Math.round(totals((r) => r.idleLoss))}; credits discarded at the cap ${Math.round(totals((r) => r.capDiscard))}`);
  out[p.name] = { weeks, milestones: ms };
}
const j = opt("json", "");
if (j) writeFileSync(j, JSON.stringify(out, null, 1));
