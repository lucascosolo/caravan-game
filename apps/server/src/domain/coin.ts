import { TUNABLES } from "@caravan/content";

/**
 * Pure Coin math (chunk 16): the lazy passive trickle, the storage-cap credit
 * rule shared by every earn path, and the debit rule merges spend through.
 * Nothing here reads a clock or touches a repository — callers always supply
 * `now`, matching the "no wall-clock reads" discipline used elsewhere in this
 * codebase (e.g. StandingPartyService's `takenAt`).
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_TRICKLE_COIN = MS_PER_HOUR / TUNABLES.COIN_TRICKLE_RATE_PER_HOUR;
if (!Number.isInteger(MS_PER_TRICKLE_COIN)) {
  // Fail fast rather than silently drift: the read-frequency-independence
  // guarantee (ECON-02) depends on this division being exact.
  throw new Error(
    `COIN_TRICKLE_RATE_PER_HOUR (${TUNABLES.COIN_TRICKLE_RATE_PER_HOUR}) must evenly divide ${MS_PER_HOUR}ms`,
  );
}

export interface TrickleComputation {
  readonly coinsEarned: number;
  /** The cursor to persist. Advances only by whole MS_PER_TRICKLE_COIN
   * multiples, carrying any remainder forward — this is what makes reading
   * 10 times across an hour total the same as reading once. */
  readonly newCursor: string;
}

/** How much trickle accrued between two instants, and how far the settlement
 * cursor should advance. Deterministic and read-frequency-independent by
 * construction: splitting one long interval into many short reads never
 * changes the total, because leftover sub-coin milliseconds are always
 * carried in the cursor rather than discarded. */
export function computeTrickle(lastTrickleAt: string, now: string): TrickleComputation {
  const elapsedMs = Date.parse(now) - Date.parse(lastTrickleAt);
  if (elapsedMs <= 0) {
    return { coinsEarned: 0, newCursor: lastTrickleAt };
  }
  const coinsEarned = Math.trunc(elapsedMs / MS_PER_TRICKLE_COIN);
  const consumedMs = coinsEarned * MS_PER_TRICKLE_COIN;
  const newCursor = new Date(Date.parse(lastTrickleAt) + consumedMs).toISOString();
  return { coinsEarned, newCursor };
}

export interface CreditResult {
  readonly newBalance: number;
  readonly applied: number;
  readonly discarded: number;
}

/** Storage-cap enforcement, shared by every credit path — trickle, encounter
 * reward, banked-trip bonus, party-win reward, and (later) purchases. Never
 * discards silently: callers surface `discarded` as an explicit warning /
 * ledger event rather than dropping it (GUARDRAILS.md, chunk 16). */
export function creditCoin(balance: number, amount: number, cap: number = TUNABLES.COIN_STORAGE_CAP): CreditResult {
  if (amount < 0) throw new RangeError(`credit amount must be non-negative, got ${amount}`);
  const headroom = Math.max(0, cap - balance);
  const applied = Math.min(amount, headroom);
  const discarded = amount - applied;
  return { newBalance: balance + applied, applied, discarded };
}

export class InsufficientCoinError extends Error {
  constructor(required: number, available: number) {
    super(`insufficient Coin: need ${required}, have ${available}`);
    this.name = "InsufficientCoinError";
  }
}

export function debitCoin(balance: number, amount: number): number {
  if (amount < 0) throw new RangeError(`debit amount must be non-negative, got ${amount}`);
  if (amount > balance) throw new InsufficientCoinError(amount, balance);
  return balance - amount;
}

/** Per-encounter Coin reward: COIN_PER_ENCOUNTER_BASE at encounter 1 (1-based),
 * compounding ×COIN_PER_ENCOUNTER_MULT_MILLI per subsequent encounter, integer
 * truncation at every step — no floats escape this. */
export function encounterCoinReward(encounterIndex: number): number {
  if (!Number.isInteger(encounterIndex) || encounterIndex < 1) {
    throw new RangeError(`encounterIndex must be a positive integer (1-based), got ${encounterIndex}`);
  }
  let amount: number = TUNABLES.COIN_PER_ENCOUNTER_BASE;
  for (let i = 1; i < encounterIndex; i++) {
    amount = Math.trunc((amount * TUNABLES.COIN_PER_ENCOUNTER_MULT_MILLI) / 1000);
  }
  return amount;
}
