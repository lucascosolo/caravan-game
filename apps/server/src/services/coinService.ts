import { TUNABLES } from "@caravan/content";
import {
  creditCoin,
  debitCoin,
  computeTrickle,
  encounterCoinReward,
  type CreditResult,
} from "../domain/coin.js";
import type {
  CoinEarnedEvent,
  CoinSpentEvent,
  CoinOverflowDiscardedEvent,
  CoinEarnSource,
} from "../domain/ledger.js";
import type { AccountRepository, LedgerRepository } from "../repo/inMemory.js";
import type { IdGenerator } from "../domain/ids.js";

export class InsufficientCoinError extends Error {
  constructor(required: number, available: number) {
    super(`insufficient Coin: need ${required}, have ${available}`);
    this.name = "InsufficientCoinError";
  }
}

export class AccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Account ${accountId} not found`);
    this.name = "AccountNotFoundError";
  }
}

/**
 * Orchestrates Coin earning, spending, and the lazy passive trickle.
 * Every credit/debit goes through this service, which enforces the storage
 * cap, keeps the trickle cursor, and writes each event to the ledger.
 */
export class CoinService {
  constructor(
    private readonly accountRepo: AccountRepository,
    private readonly ledgerRepo: LedgerRepository,
    private readonly idGen: IdGenerator,
  ) {}

  private requireAccount(accountId: string) {
    const account = this.accountRepo.get(accountId);
    if (!account) throw new AccountNotFoundError(accountId);
    return account;
  }

  /**
   * Credit Coin from any earn source. Applies the storage cap, surfaces
   * any discarded overflow, and writes both the earned and potentially
   * discarded events to the ledger.
   */
  credit(
    accountId: string,
    amount: number,
    source: CoinEarnSource,
    causationId: string,
    now: string,
  ): CreditResult {
    const account = this.requireAccount(accountId);
    const result = creditCoin(account.coinBalance, amount);
    this.accountRepo.save({ ...account, coinBalance: result.newBalance });
    this.ledgerRepo.append({
      id: this.idGen.next("event"),
      accountId,
      caravanId: null,
      causationId,
      createdAt: now,
      kind: "coin_earned",
      source,
      amountRequested: amount,
      amountApplied: result.applied,
    } as CoinEarnedEvent);
    if (result.discarded > 0) {
      this.ledgerRepo.append({
        id: this.idGen.next("event"),
        accountId,
        caravanId: null,
        causationId,
        createdAt: now,
        kind: "coin_overflow_discarded",
        source,
        amountDiscarded: result.discarded,
      } as CoinOverflowDiscardedEvent);
    }
    return result;
  }

  /**
   * Debit Coin for a spend (merge, recruit, etc). Throws InsufficientCoinError
   * if the balance is too low.
   */
  debit(accountId: string, amount: number, reason: "merge", causationId: string, now: string): number {
    const account = this.requireAccount(accountId);
    try {
      const newBalance = debitCoin(account.coinBalance, amount);
      this.accountRepo.save({ ...account, coinBalance: newBalance });
      this.ledgerRepo.append({
        id: this.idGen.next("event"),
        accountId,
        caravanId: null,
        causationId,
        createdAt: now,
        kind: "coin_spent",
        reason,
        amount,
      } as CoinSpentEvent);
      return newBalance;
    } catch (e) {
      if (e instanceof Error && e.name === "InsufficientCoinError") {
        throw new InsufficientCoinError(
          (e as any).required ?? 0,
          (e as any).available ?? account.coinBalance,
        );
      }
      throw e;
    }
  }

  /** Current Coin balance for the account. */
  getBalance(accountId: string): number {
    const account = this.requireAccount(accountId);
    return account.coinBalance;
  }

  /**
   * Lazily compute and credit the passive trickle since the last settlement.
   * Deterministic and read-frequency-independent by construction (see
   * computeTrickle in domain/coin.ts). Returns the trickle result including
   * the updated cursor.
   */
  computeAndApplyTrickle(accountId: string, now: string): CreditResult {
    const account = this.requireAccount(accountId);
    const trickle = computeTrickle(account.coinLastTrickleAt, now);
    if (trickle.coinsEarned <= 0) {
      return { newBalance: account.coinBalance, applied: 0, discarded: 0 };
    }
    const result = creditCoin(account.coinBalance, trickle.coinsEarned);
    this.accountRepo.save({
      ...account,
      coinBalance: result.newBalance,
      coinLastTrickleAt: trickle.newCursor,
    });
    this.ledgerRepo.append({
      id: this.idGen.next("event"),
      accountId,
      caravanId: null,
      causationId: "trickle",
      createdAt: now,
      kind: "coin_earned",
      source: "trickle",
      amountRequested: trickle.coinsEarned,
      amountApplied: result.applied,
    } as CoinEarnedEvent);
    if (result.discarded > 0) {
      this.ledgerRepo.append({
        id: this.idGen.next("event"),
        accountId,
        caravanId: null,
        causationId: "trickle",
        createdAt: now,
        kind: "coin_overflow_discarded",
        source: "trickle",
        amountDiscarded: result.discarded,
      } as CoinOverflowDiscardedEvent);
    }
    return result;
  }

  /** Compute and credit Coin for surviving an encounter. */
  creditEncounterReward(
    accountId: string,
    encounterIndex: number,
    causationId: string,
    now: string,
  ): CreditResult {
    const amount = encounterCoinReward(encounterIndex);
    return this.credit(accountId, amount, "encounter", causationId, now);
  }

  /** Compute and credit Coin for banking a trip. */
  creditBankedTrip(accountId: string, causationId: string, now: string): CreditResult {
    const amount = TUNABLES.COIN_PER_BANKED_TRIP;
    return this.credit(accountId, amount, "banked_trip", causationId, now);
  }

  /** Credit Coin for a standing party win. */
  creditPartyWin(accountId: string, causationId: string, now: string): CreditResult {
    const amount = TUNABLES.COIN_PER_PARTY_WIN;
    return this.credit(accountId, amount, "party_win", causationId, now);
  }
}