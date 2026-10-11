/**
 * Trip expected-value model (chunk 19 QA D2c). A small, reusable, OFFLINE model of the
 * bank-or-push decision, built from the real tunables and the real earn math (the server's
 * own `coinForEncounter` / `coinForDelivery`, matchmaking's `bandOf`) and the rebuild-cost
 * math the chunk 19 tests pin. It is NOT the simulation and never runs in the server: hold
 * rates and deaths are INPUTS — today guesses, after chunk 13 resolver-measured rates (the
 * PHASE-2 §37 balance pass feeds them in). Floats are fine here; nothing here reaches a
 * resolution.
 *
 * Unit losses are valued at their rebuild Coin, so a trip's EV is in one currency:
 *   - a death costs V(L) − V(L−1) (one merge level; nothing at level 1, the floor);
 *   - a unit alive at the collapse costs V(L) (destroyed);
 * where V(1) is a mercenary (MERCENARY_COST_BASE; a refugee is free but slow) and
 * V(L) = MERGE_COST_BY_TARGET_LEVEL[L] + V(L−1) × (spend / produce) of the cheapest recipe
 * (5 → 3: 5/3 inputs per output) — the amortised same-type rebuild price.
 */
import { TUNABLES } from "../../packages/content/src/index.js";
import { coinForDelivery, coinForEncounter } from "../../apps/server/src/economy/coin.js";
import { bandOf } from "../../apps/server/src/matchmaking/band.js";

const recipes = TUNABLES.MERGE_RECIPES as readonly { spend: number; produce: number }[];

/** The recipe with the fewest inputs per output (5 → 3 at the defaults). */
function cheapestRecipe(): { spend: number; produce: number } {
  return [...recipes].sort((a, b) => a.spend / a.produce - b.spend / b.produce)[0]!;
}

/** Amortised Coin to rebuild ONE unit of level `level` from mercenary level-1s, same type, at the cheapest recipe rate. */
export function unitValue(level: number): number {
  if (level <= 1) return TUNABLES.MERCENARY_COST_BASE;
  const r = cheapestRecipe();
  return TUNABLES.MERGE_COST_BY_TARGET_LEVEL[level]! + unitValue(level - 1) * (r.spend / r.produce);
}

/** Coin a death costs at `level`: one merge level, floored at 1 (a level-1 death costs nothing). */
export function deathCost(level: number): number {
  return level <= TUNABLES.MERGE_LEVEL_MIN ? 0 : unitValue(level) - unitValue(level - 1);
}

export interface RebuildPlan {
  /** Inputs needed at each level from the top down: L(level−1), …, L1. */
  inputsByLevel: number[];
  level1: number;
  mergeCoin: number;
  mercenaryCoin: number;
  totalCoin: number;
  /** Wall-clock hours to collect the level-1s from the free refugee drip instead. */
  refugeeHours: number;
}

/**
 * The exact cheapest plan to rebuild `count` units of ONE type at `level` from level 1:
 * greedy from the top — as many 5 → 3 batches as fit, then 2 → 1 for the rest (5 → 3 is the
 * same Coin per produced unit with fewer inputs). Integer, as the merge board would do it.
 */
export function rebuildPlan(count: number, level: number): RebuildPlan {
  const two = recipes.find((r) => r.spend === 2 && r.produce === 1);
  const five = recipes.find((r) => r.spend === 5 && r.produce === 3);
  if (!two || !five) throw new Error("rebuildPlan expects the 2→1 and 5→3 recipes");
  let need = count;
  let mergeCoin = 0;
  const inputsByLevel: number[] = [];
  for (let target = level; target >= 2; target--) {
    const big = Math.floor(need / five.produce);
    const rest = need - big * five.produce;
    const small = Math.ceil(rest / two.produce);
    mergeCoin += (big * five.produce + small * two.produce) * TUNABLES.MERGE_COST_BY_TARGET_LEVEL[target]!;
    need = big * five.spend + small * two.spend;
    inputsByLevel.push(need);
  }
  const mercenaryCoin = need * TUNABLES.MERCENARY_COST_BASE;
  return { inputsByLevel, level1: need, mergeCoin, mercenaryCoin, totalCoin: mergeCoin + mercenaryCoin, refugeeHours: (need * TUNABLES.REFUGEE_REFRESH_INTERVAL_MINUTES) / 60 };
}

/** Rebuilding a circle of mixed types: each unit is its own type, so each is rebuilt alone. */
export function rebuildMixed(levels: readonly number[]): RebuildPlan {
  const plans = levels.map((l) => rebuildPlan(1, l));
  const sum = (f: (p: RebuildPlan) => number) => plans.reduce((s, p) => s + f(p), 0);
  return { inputsByLevel: [], level1: sum((p) => p.level1), mergeCoin: sum((p) => p.mergeCoin), mercenaryCoin: sum((p) => p.mercenaryCoin), totalCoin: sum((p) => p.totalCoin), refugeeHours: sum((p) => p.refugeeHours) };
}

export interface TripModelInput {
  /** P(hold encounter j | reached it), 1-based. */
  holdRate: (encounterIndex: number) => number;
  /** Expected unit deaths per HELD encounter (they stay dead for the rest of the trip). */
  deathsPerHeld: number;
  /** Merge levels of the packed units. */
  circle: readonly number[];
  /** The caravan's living display band (encounter Coin scales with it). */
  band: number;
  /** Of the units alive when the caravan falls, the share that die IN that fight (de-merged, not destroyed). */
  finalFightDeathShare: number;
  /** Earn-floor multiplier on encounter Coin (1 = paid in full; in-band parties always are). */
  earnMultiplier?: number;
}

/** Coin a trip delivers when banked after k survived encounters: scaled encounter Coin + delivery. */
export function bankValue(k: number, band: number, earnMultiplier = 1): number {
  let total = coinForDelivery(k);
  for (let i = 1; i <= k; i++) total += Math.floor(coinForEncounter(i, band) * earnMultiplier);
  return total;
}

/** P(reaching and holding encounters 1..k). */
export function survival(k: number, holdRate: (j: number) => number): number {
  let s = 1;
  for (let j = 1; j <= k; j++) s *= Math.max(0, Math.min(1, holdRate(j)));
  return s;
}

/**
 * EV of the plan "push until k survived, then bank", in Coin, unit losses at rebuild value.
 * Gross Coin is what the trip earns; EV subtracts the expected rebuild cost of its losses.
 */
export function tripEV(k: number, m: TripModelInput): { ev: number; grossCoin: number; unitCost: number } {
  const n = m.circle.length;
  const avgDeath = m.circle.reduce((s, l) => s + deathCost(l), 0) / n;
  const avgValue = m.circle.reduce((s, l) => s + unitValue(l), 0) / n;
  let unitCost = 0;
  let reach = 1;
  for (let j = 1; j <= k; j++) {
    const p = Math.max(0, Math.min(1, m.holdRate(j)));
    const dead = Math.min(n, m.deathsPerHeld * (j - 1));
    const alive = n - dead;
    const overrunLoss = dead * avgDeath + alive * m.finalFightDeathShare * avgDeath + alive * (1 - m.finalFightDeathShare) * avgValue;
    unitCost += reach * (1 - p) * overrunLoss;
    reach *= p;
  }
  const deadAtBank = Math.min(n, m.deathsPerHeld * k);
  unitCost += reach * deadAtBank * avgDeath;
  const grossCoin = reach * bankValue(k, m.band, m.earnMultiplier ?? 1);
  return { ev: grossCoin - unitCost, grossCoin, unitCost };
}

/** EV for bank points 1..maxK and the best one. */
export function evRow(m: TripModelInput, maxK = 6): { evs: number[]; best: number; gross: number[] } {
  const evs: number[] = [];
  const gross: number[] = [];
  for (let k = 1; k <= maxK; k++) {
    const r = tripEV(k, m);
    evs.push(r.ev);
    gross.push(r.grossCoin);
  }
  let best = 0;
  for (let i = 1; i < evs.length; i++) if (evs[i]! > evs[best]!) best = i;
  return { evs, best: best + 1, gross };
}

/** A linear hold-rate curve: p1 at encounter 1, falling by `decay` per encounter after. */
export function linearHold(p1: number, decay: number): (j: number) => number {
  return (j) => p1 - decay * (j - 1);
}

/** An explicit hold-rate curve (resolver-measured), the last value repeating. */
export function curveHold(curve: readonly number[]): (j: number) => number {
  if (curve.length === 0) throw new Error("empty hold-rate curve");
  return (j) => curve[Math.min(j, curve.length) - 1]!;
}

export const START_BAND = bandOf(TUNABLES.REPUTATION_START).index;

/**
 * Chunk 37 balance pass (BALANCE-LOG.md): the display band an 8 × L1 circle settles at, measured
 * by the matchup sweep (the highest band whose skilled encounter-1 hold rate clears the Reputation
 * break-even). The weekly free earn is derived there, not at REPUTATION_START's band — since the
 * pass a new caravan starts at band 1 and climbs. Re-measure when content or the authored set move.
 */
export const L1_EQUILIBRIUM_BAND = 3;

/**
 * Weekly free Coin (chunk 19 QA D3): the full-week trickle plus `tripsPerWeek` trips' gross
 * Coin, each banked at the best-EV point for an 8 × L1 circle (the cheapest circle to lose,
 * so the most-pushed — the generous end of "realistic").
 */
export function weeklyFreeEarn(tripsPerWeek: number, p1: number, decay: number, band = L1_EQUILIBRIUM_BAND): { trickle: number; perTrip: number; bankAt: number; total: number } {
  const trickle = TUNABLES.COIN_TRICKLE_RATE_PER_HOUR * 24 * 7;
  const m: TripModelInput = { holdRate: linearHold(p1, decay), deathsPerHeld: 0.5, circle: Array(TUNABLES.DEPLOYMENT_SLOT_CAP).fill(1), band, finalFightDeathShare: 0.5 };
  const row = evRow(m);
  const perTrip = row.gross[row.best - 1]!;
  return { trickle, perTrip, bankAt: row.best, total: trickle + tripsPerWeek * perTrip };
}
