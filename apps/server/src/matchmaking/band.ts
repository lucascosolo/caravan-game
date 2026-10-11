/**
 * Matchmaking's pure core (chunk 14): Reputation banding, difficulty escalation, the
 * authored-share cap, the sandbagging earn floor and the seeded candidate draw. No I/O,
 * no clock, no Math.random, no floats — whole integers and the xorshift32 draw chunk 18
 * uses, so a menu is reproducible from (pool, seed, centre, exclusions) alone
 * (GUARDRAILS §1: randomness only in WHICH options are offered, seeded from stored state).
 *
 * What is NOT here, on purpose: region (cross-region encounters are intentional
 * diversity), build similarity (same), the owner being online or busy (a standing party is
 * a template and is always available), and anything about Coin, purchases or entitlements
 * (the reroll is free and time-gated; a test greps this directory for Coin words).
 */
import { FIXED_ONE, TUNABLES, type Fixed } from "@caravan/content";
import { fnv1a32, uniformBelow } from "../acquisition/refugeeMenu.js";

export const CANDIDATES_PER_SEARCH: number = TUNABLES.CANDIDATES_PER_SEARCH;
export const REPUTATION_BAND_WIDTH: number = TUNABLES.REPUTATION_BAND_WIDTH;
export const REPUTATION_BAND_WIDEN_STEP: number = TUNABLES.REPUTATION_BAND_WIDEN_STEP;
export const REPUTATION_BAND_WIDTH_MAX: number = TUNABLES.REPUTATION_BAND_WIDTH_MAX;
export const REROLL_COOLDOWN_SECONDS: number = TUNABLES.REROLL_COOLDOWN_SECONDS;
export const RECENT_OPPONENT_EXCLUSION: number = TUNABLES.RECENT_OPPONENT_EXCLUSION;
export const DIFFICULTY_ESCALATION_BP: number = TUNABLES.DIFFICULTY_ESCALATION_BP;
export const AUTHORED_PARTY_MAX_SHARE_BP: number = TUNABLES.AUTHORED_PARTY_MAX_SHARE_BP;
export const SANDBAG_EARN_GAP_START: number = TUNABLES.SANDBAG_EARN_GAP_START;
export const SANDBAG_EARN_MULT_MIN: Fixed = TUNABLES.SANDBAG_EARN_MULT_MIN;
const BP_ONE = 10_000;

/** The size of one display band: the full span of the first search pass. */
export const BAND_SPAN: number = 2 * REPUTATION_BAND_WIDTH;

for (const [name, v] of Object.entries({ CANDIDATES_PER_SEARCH, REPUTATION_BAND_WIDTH, REPUTATION_BAND_WIDEN_STEP, REPUTATION_BAND_WIDTH_MAX, REROLL_COOLDOWN_SECONDS, RECENT_OPPONENT_EXCLUSION, DIFFICULTY_ESCALATION_BP, AUTHORED_PARTY_MAX_SHARE_BP, SANDBAG_EARN_GAP_START })) {
  if (!Number.isInteger(v) || v < 0) throw new Error(`TUNABLES.${name} must be a non-negative integer, got ${String(v)}`);
}
if (CANDIDATES_PER_SEARCH < 1) throw new Error("TUNABLES.CANDIDATES_PER_SEARCH must be at least 1");
if (REPUTATION_BAND_WIDTH < 1 || REPUTATION_BAND_WIDEN_STEP < 1) throw new Error("band width and widen step must be positive");
if (REPUTATION_BAND_WIDTH_MAX < REPUTATION_BAND_WIDTH) throw new Error("TUNABLES.REPUTATION_BAND_WIDTH_MAX must be at least REPUTATION_BAND_WIDTH");
if (AUTHORED_PARTY_MAX_SHARE_BP >= BP_ONE) throw new Error("TUNABLES.AUTHORED_PARTY_MAX_SHARE_BP must be below 10000");
if (TUNABLES.SELF_EXCLUDE !== true) throw new Error("TUNABLES.SELF_EXCLUDE is fixed by design: a caravan never meets its own party");
if (TUNABLES.EMPTY_POOL_BEHAVIOR !== "widen_then_authored") throw new Error("TUNABLES.EMPTY_POOL_BEHAVIOR is fixed by design");

/** TUNABLES.CANDIDATE_SELECTION_SEED: fnv1a32(`<caravan id>:<trip id>:<encounter index>:<search seq>`), ids lowercased. */
export function candidateSeed(caravanId: string, tripId: string, encounterIndex: number, searchSeq: number): number {
  if (!Number.isInteger(encounterIndex) || encounterIndex < 1) throw new RangeError("encounterIndex must be a positive integer");
  if (!Number.isInteger(searchSeq) || searchSeq < 1) throw new RangeError("searchSeq must be a positive integer");
  return fnv1a32(`${caravanId.toLowerCase()}:${tripId.toLowerCase()}:${encounterIndex}:${searchSeq}`);
}

/** DIFFICULTY_ESCALATION: how much the band centre rises for encounter `encounterIndex` (1-based) of a trip. */
export function escalationFor(encounterIndex: number): number {
  if (!Number.isInteger(encounterIndex) || encounterIndex < 1) throw new RangeError("encounterIndex must be a positive integer");
  return Math.floor((BAND_SPAN * DIFFICULTY_ESCALATION_BP * (encounterIndex - 1)) / BP_ONE);
}

/** The rise per encounter, for the player to see before pushing. */
export const ESCALATION_PER_ENCOUNTER: number = escalationFor(2);

/** The band centre for a caravan of `livingRating` at encounter `encounterIndex`. */
export function escalatedCentre(livingRating: number, encounterIndex: number): number {
  if (!Number.isInteger(livingRating)) throw new RangeError("livingRating must be an integer");
  return livingRating + escalationFor(encounterIndex);
}

/** The half-widths a search tries, in order: WIDTH, +STEP, +2·STEP … capped at WIDTH_MAX (always included last). */
export function bandWidths(): number[] {
  const out: number[] = [];
  for (let w = REPUTATION_BAND_WIDTH; w < REPUTATION_BAND_WIDTH_MAX; w += REPUTATION_BAND_WIDEN_STEP) out.push(w);
  out.push(REPUTATION_BAND_WIDTH_MAX);
  return out;
}

export interface BandInfo {
  index: number;
  low: number;
  /** Inclusive. */
  high: number;
}

/** Display band of a rating: band k covers [FLOOR + k·SPAN, FLOOR + (k+1)·SPAN). Ratings below the floor read as band 0. */
export function bandOf(rating: number): BandInfo {
  if (!Number.isInteger(rating)) throw new RangeError("rating must be an integer");
  const index = Math.max(0, Math.floor((rating - TUNABLES.REPUTATION_FLOOR) / BAND_SPAN));
  const low = TUNABLES.REPUTATION_FLOOR + index * BAND_SPAN;
  return { index, low, high: low + BAND_SPAN - 1 };
}

/** The centre rating of display band `index` (where authored parties for that band sit). */
export function bandCentre(index: number): number {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("band index must be a non-negative integer");
  return TUNABLES.REPUTATION_FLOOR + index * BAND_SPAN + Math.floor(BAND_SPAN / 2);
}

export const AUTHORED_SERVED_SHARE_WINDOW: number = TUNABLES.AUTHORED_SERVED_SHARE_WINDOW;
export const AUTHORED_OVER_SHARE_WEIGHT_BP: number = TUNABLES.AUTHORED_OVER_SHARE_WEIGHT_BP;
if (!Number.isInteger(AUTHORED_SERVED_SHARE_WINDOW) || AUTHORED_SERVED_SHARE_WINDOW < 1) throw new Error("TUNABLES.AUTHORED_SERVED_SHARE_WINDOW must be a positive integer");
if (!Number.isInteger(AUTHORED_OVER_SHARE_WEIGHT_BP) || AUTHORED_OVER_SHARE_WEIGHT_BP < 0 || AUTHORED_OVER_SHARE_WEIGHT_BP > BP_ONE) throw new Error("TUNABLES.AUTHORED_OVER_SHARE_WEIGHT_BP must be 0..10000");

/**
 * Retire-by-ratio, second stage (chunk 25): the authored share of the encounters SERVED in
 * one display band, over the most recent AUTHORED_SERVED_SHARE_WINDOW chosen candidates
 * whose search centre fell in that band. Read from encounter_candidates at search time
 * (matchmaking/authoredShare.ts) and stored with the menu, so the draw replays from the
 * row. `served` ≤ window; `authored` ≤ served.
 */
export interface AuthoredServedShare {
  readonly band: number;
  readonly window: number;
  readonly served: number;
  readonly authored: number;
}

/** Whether a band's authored served share is over AUTHORED_PARTY_MAX_SHARE_BP. Integer compare; an empty window is never over. */
export function authoredOverShare(share: AuthoredServedShare | null | undefined): boolean {
  if (!share) return false;
  if (!Number.isInteger(share.served) || !Number.isInteger(share.authored) || share.served < 0 || share.authored < 0 || share.authored > share.served) {
    throw new RangeError("authored served share must be whole counts with authored ≤ served");
  }
  return share.served > 0 && share.authored * BP_ONE > share.served * AUTHORED_PARTY_MAX_SHARE_BP;
}

/**
 * AUTHORED_PARTY_MAX_SHARE, first stage (the draw-pool cap): how many authored parties may
 * join a draw that holds `live` live parties: floor(live × share / (1 − share)), so
 * authored ≤ share of the pool. When the band is over its SERVED share (second stage) that
 * allowance is scaled by AUTHORED_OVER_SHARE_WEIGHT_BP, floored — authored parties are
 * weighted down, not switched off, and the weight lifts by itself once live parties have
 * been served enough to bring the share back under the cap.
 *
 * `fill` (chunk 14 QA S4): only the WIDEST pass may let authored parties fill the menu up
 * to `candidates`. Narrower passes widen first, with authored parties by ratio only, so
 * live parties one step wider are preferred over authored ones in band.
 */
export function authoredAllowance(live: number, candidates: number = CANDIDATES_PER_SEARCH, opts: { fill?: boolean; overShare?: boolean } = {}): number {
  if (!Number.isInteger(live) || live < 0) throw new RangeError("live must be a non-negative integer");
  let byRatio = Math.floor((live * AUTHORED_PARTY_MAX_SHARE_BP) / (BP_ONE - AUTHORED_PARTY_MAX_SHARE_BP));
  if (opts.overShare) byRatio = Math.floor((byRatio * AUTHORED_OVER_SHARE_WEIGHT_BP) / BP_ONE);
  if (opts.fill === false) return byRatio;
  return Math.max(byRatio, candidates - live, 0);
}

/**
 * Sandbagging floor (chunk 04 QA D2 / PHASE-2 §31): the multiplier on Coin earned for an
 * encounter, from the rating gap (caravan living − party owner siege). FIXED_ONE up to
 * SANDBAG_EARN_GAP_START, then falling by FIXED_ONE per REPUTATION_GAP_DIVISOR of extra
 * gap, floored at SANDBAG_EARN_MULT_MIN. Integer fixed-point; chunk 19 applies it.
 */
export function sandbagEarnMultiplier(gap: number): Fixed {
  if (!Number.isInteger(gap)) throw new RangeError("gap must be an integer");
  if (gap <= SANDBAG_EARN_GAP_START) return FIXED_ONE;
  const over = gap - SANDBAG_EARN_GAP_START;
  const scaled = FIXED_ONE - Math.floor((over * FIXED_ONE) / TUNABLES.REPUTATION_GAP_DIVISOR);
  return Math.max(SANDBAG_EARN_MULT_MIN, scaled) as Fixed;
}

/** One party as the draw sees it. Nothing else about a party or its owner enters selection. */
export interface PoolEntry {
  readonly partyId: string;
  readonly ownerAccountId: string;
  /** The owner's siege Reputation (chunk 04 QA D1). */
  readonly rating: number;
  /** Owned by a system account (PHASE-2 §25). Only the share cap reads this. */
  readonly authored: boolean;
}

export interface SelectionInput {
  readonly centre: number;
  readonly seed: number;
  /** Every servable party after exclusions. Order is irrelevant: it is sorted by party id first. */
  readonly pool: readonly PoolEntry[];
  /** Parties to skip (they did not resolve when snapshotted). Replay input. */
  readonly skipped?: ReadonlySet<string>;
  readonly count?: number;
  /** The band's authored served share at search time (chunk 25). Replay input; absent/null = not weighted. */
  readonly authoredServed?: AuthoredServedShare | null;
}

export interface SelectionPass {
  width: number;
  live: number;
  authoredInBand: number;
  authoredAllowed: number;
}

export interface SelectionResult {
  /** Up to `count` picks, in menu order. Fewer only when the whole pool (live + authored) cannot fill the menu. */
  picks: PoolEntry[];
  /** The half-width of the pass that filled the menu (or the widest, when none did). */
  bandWidthUsed: number;
  /** Every pass tried, for legibility. */
  passes: SelectionPass[];
  /** True when the menu needed authored parties from OUTSIDE the widest band. */
  usedAuthoredFallback: boolean;
  /** Chunk 25: the band was over its authored served share, so authored allowances were weighted down. */
  authoredWeightedDown: boolean;
}

function sortedById(entries: readonly PoolEntry[]): PoolEntry[] {
  const out = [...entries];
  out.sort((a, b) => (a.partyId < b.partyId ? -1 : a.partyId > b.partyId ? 1 : 0));
  for (let i = 1; i < out.length; i++) if (out[i]!.partyId === out[i - 1]!.partyId) throw new RangeError(`duplicate party id in pool: ${out[i]!.partyId}`);
  return out;
}

/** Seeded Fisher–Yates over the first `take` slots; returns the advanced state. */
function seededTake<T>(items: T[], state: number, take: number): { picked: T[]; state: number } {
  const arr = [...items];
  let s = state;
  const n = Math.min(take, arr.length);
  for (let i = 0; i < n; i++) {
    const r = uniformBelow(s, arr.length - i);
    s = r.state;
    const j = i + r.value;
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return { picked: arr.slice(0, n), state: s };
}

/**
 * The draw. For each half-width in bandWidths(): the live parties in band plus up to
 * authoredAllowance(live) authored parties in band (seeded choice when more are in band)
 * form the eligible set; if it holds at least `count`, `count` are drawn from it (seeded)
 * and the search ends. Narrower passes admit authored parties BY RATIO ONLY (chunk 14 QA
 * S4): a thin band widens before authored parties fill it, so a live party one step wider
 * beats an authored one in band; only the widest pass lets authored parties fill the menu.
 * If the band is over its authored SERVED share (`authoredServed`, chunk 25) every
 * allowance is weighted down by AUTHORED_OVER_SHARE_WEIGHT_BP. If no width fills the menu,
 * EMPTY_POOL_BEHAVIOR: everything in the widest band, then authored parties outside it
 * nearest the centre first (ties by party id), until the menu is full — or until the pool
 * runs out, in which case fewer are returned and the caller reports an unservable pool.
 * Pure and deterministic: the same (pool, seed, centre, skipped, authoredServed) always
 * yields the same picks, whatever order `pool` came in.
 */
export function selectCandidates(input: SelectionInput): SelectionResult {
  const count = input.count ?? CANDIDATES_PER_SEARCH;
  if (!Number.isInteger(count) || count < 1) throw new RangeError("count must be a positive integer");
  if (!Number.isInteger(input.centre)) throw new RangeError("centre must be an integer");
  if (!Number.isInteger(input.seed) || input.seed < 0) throw new RangeError("seed must be a non-negative integer");
  const skipped = input.skipped ?? new Set<string>();
  const pool = sortedById(input.pool).filter((p) => !skipped.has(p.partyId));
  for (const p of pool) if (!Number.isInteger(p.rating)) throw new RangeError(`party ${p.partyId} rating must be an integer`);
  const passes: SelectionPass[] = [];
  let state = input.seed >>> 0;
  const widths = bandWidths();
  const overShare = authoredOverShare(input.authoredServed);
  for (let k = 0; k < widths.length; k++) {
    const width = widths[k]!;
    const fill = k === widths.length - 1;
    const inBand = pool.filter((p) => Math.abs(p.rating - input.centre) <= width);
    const live = inBand.filter((p) => !p.authored);
    const authored = inBand.filter((p) => p.authored);
    const allowed = Math.min(authored.length, authoredAllowance(live.length, count, { fill, overShare }));
    passes.push({ width, live: live.length, authoredInBand: authored.length, authoredAllowed: allowed });
    let eligible = live;
    if (allowed > 0) {
      const a = seededTake(authored, state, allowed);
      state = a.state;
      eligible = sortedById([...live, ...a.picked]);
    }
    if (eligible.length >= count) {
      const draw = seededTake(eligible, state, count);
      return { picks: draw.picked, bandWidthUsed: width, passes, usedAuthoredFallback: false, authoredWeightedDown: overShare };
    }
  }
  // Fallback: the widest band in full, then authored parties beyond it, nearest first.
  const widest = widths[widths.length - 1]!;
  const inBand = pool.filter((p) => Math.abs(p.rating - input.centre) <= widest);
  const outside = pool
    .filter((p) => p.authored && Math.abs(p.rating - input.centre) > widest)
    .sort((a, b) => Math.abs(a.rating - input.centre) - Math.abs(b.rating - input.centre) || (a.partyId < b.partyId ? -1 : 1));
  const filler = outside.slice(0, Math.max(0, count - inBand.length));
  const draw = seededTake(sortedById([...inBand, ...filler]), state, count);
  return { picks: draw.picked, bandWidthUsed: widest, passes, usedAuthoredFallback: filler.length > 0, authoredWeightedDown: overShare };
}
