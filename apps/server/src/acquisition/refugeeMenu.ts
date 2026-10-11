/**
 * The refugee menu draw (chunk 18) — pure, integer-only, no clock, no library randomness.
 *
 * GUARDRAILS §1 allows randomness in exactly one place: WHICH OPTIONS ARE OFFERED. This
 * module is that place for the refugee drip. The seed is derived from (caravan id, refresh
 * sequence number) and the draw is a plain xorshift32 over the caravan's unlocked living
 * pool, so the same stored inputs reproduce the same menu forever and a QA pass can replay
 * any menu from its row alone (`replayMenu`). Nothing about the player's Coin, spend
 * history or account enters the draw — a reroll only moves the sequence number.
 *
 * Weighting (TUNABLES.REFUGEE_OFFER_WEIGHTING): uniform without replacement over the pool
 * sorted by type id; when the pool holds fewer than REFUGEE_OFFER_COUNT types, the remaining
 * slots are drawn uniformly WITH replacement from the same pool, so a menu is always exactly
 * REFUGEE_OFFER_COUNT offers. No unlocked type is ever weighted or excluded.
 */
import { TUNABLES } from "@caravan/content";

const U32 = 0x1_0000_0000;

/** FNV-1a, 32-bit, over the UTF-16 code units of `s`. Returns an unsigned 32-bit integer. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619 mod 2^32; Math.imul is exact 32-bit integer multiplication.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** TUNABLES.REFUGEE_OFFER_SEED: fnv1a32(`<caravan id, lowercased>:<sequence>`). */
export function menuSeed(caravanId: string, sequence: number): number {
  if (!Number.isInteger(sequence) || sequence < 1) throw new RangeError(`sequence must be a positive integer, got ${String(sequence)}`);
  return fnv1a32(`${caravanId.toLowerCase()}:${sequence}`);
}

/** xorshift32. State must be non-zero; a zero seed is nudged to a fixed non-zero constant. */
function xorshift32(state: number): number {
  let x = state >>> 0;
  if (x === 0) x = 0x9e3779b9;
  x ^= (x << 13) >>> 0;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0;
  return x >>> 0;
}

/**
 * Uniform integer in [0, k) by rejection sampling, so no modulo bias however small the
 * pool. Returns the value and the advanced generator state.
 */
function uniformBelow(state: number, k: number): { value: number; state: number } {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, got ${String(k)}`);
  const limit = U32 - (U32 % k);
  let s = state;
  for (;;) {
    s = xorshift32(s);
    if (s < limit) return { value: s % k, state: s };
  }
}

export interface RefugeeDraw {
  /** The pool the draw ran over: the input, de-duplicated and sorted by type id. */
  pool: string[];
  /** Exactly `count` type ids, in slot order. */
  offers: string[];
}

/**
 * Draw `count` offers from `pool` with `seed`. The pool is de-duplicated and SORTED first,
 * so the caller's set iteration order cannot change the result. Partial Fisher–Yates for the
 * without-replacement part; extra slots (pool smaller than `count`) with replacement.
 */
export function drawRefugeeMenu(unlockedPool: Iterable<string>, seed: number, count: number = TUNABLES.REFUGEE_OFFER_COUNT): RefugeeDraw {
  if (!Number.isInteger(seed) || seed < 0 || seed >= U32) throw new RangeError(`seed must be an unsigned 32-bit integer, got ${String(seed)}`);
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`count must be a positive integer, got ${String(count)}`);
  const pool = [...new Set(unlockedPool)].sort();
  if (pool.length === 0) throw new RangeError("the unlocked living pool is empty; a caravan always has its starting types");
  const deck = [...pool];
  const offers: string[] = [];
  let state = seed;
  const distinct = Math.min(count, deck.length);
  for (let i = 0; i < distinct; i++) {
    const r = uniformBelow(state, deck.length - i);
    state = r.state;
    const j = i + r.value;
    const picked = deck[j]!;
    deck[j] = deck[i]!;
    deck[i] = picked;
    offers.push(picked);
  }
  for (let i = distinct; i < count; i++) {
    const r = uniformBelow(state, pool.length);
    state = r.state;
    offers.push(pool[r.value]!);
  }
  return { pool, offers };
}

/** The draw for a given caravan and sequence: what `refugees.ts` stores, and what QA replays. */
export function drawForSequence(caravanId: string, sequence: number, unlockedPool: Iterable<string>): RefugeeDraw & { seed: number } {
  const seed = menuSeed(caravanId, sequence);
  return { seed, ...drawRefugeeMenu(unlockedPool, seed) };
}

/**
 * Replay a stored menu row from its own stored inputs. True when the stored offers are
 * exactly what the stored seed and pool produce — the QA probe for "seeded and
 * reproducible from stored state".
 */
export function replayMenu(row: { caravan_id: string; sequence: number; seed: number; pool_type_ids: readonly string[]; offered_type_ids: readonly string[] }): {
  ok: boolean;
  expectedSeed: number;
  expectedOffers: string[];
} {
  const expectedSeed = menuSeed(row.caravan_id, row.sequence);
  const { offers } = drawRefugeeMenu(row.pool_type_ids, row.seed);
  const ok = expectedSeed === row.seed && offers.length === row.offered_type_ids.length && offers.every((o, i) => o === row.offered_type_ids[i]);
  return { ok, expectedSeed, expectedOffers: offers };
}

/**
 * Coin for the reroll at `index` (0 = first reroll of the window). Past the end of the
 * schedule the last value repeats; the window resets on every free refresh.
 */
export function rerollCost(index: number): number {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`reroll index must be a non-negative integer, got ${String(index)}`);
  const schedule = TUNABLES.REFUGEE_REROLL_COST_SCHEDULE;
  return schedule[Math.min(index, schedule.length - 1)]!;
}

export const REFUGEE_REFRESH_INTERVAL_MS = TUNABLES.REFUGEE_REFRESH_INTERVAL_MINUTES * 60_000;
