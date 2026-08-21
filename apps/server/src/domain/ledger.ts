import type { MergeRecipeKind } from "@caravan/content";

/**
 * A scoped stand-in for chunk 02's full event-sourced ledger — just the Coin
 * and merge event shapes this chunk needs (roadmap/chunks/02, "Event types to
 * define now"). Events are append-only; balances are projections over them
 * (rebuildCoinBalance below), never their own source of truth.
 */

export type CoinEarnSource = "encounter" | "banked_trip" | "party_win" | "trickle";

interface LedgerEventBase {
  readonly id: string;
  readonly accountId: string;
  /** Nullable per the account/caravan split (GUARDRAILS.md #5) — Coin events
   * not tied to a specific caravan (trickle, merges are caravan-scoped via
   * their own field) carry null here. */
  readonly caravanId: string | null;
  /** Links this event to the request/job that produced it. */
  readonly causationId: string;
  readonly createdAt: string;
}

export interface CoinEarnedEvent extends LedgerEventBase {
  readonly kind: "coin_earned";
  readonly source: CoinEarnSource;
  readonly amountRequested: number;
  readonly amountApplied: number;
}

export interface CoinSpentEvent extends LedgerEventBase {
  readonly kind: "coin_spent";
  readonly reason: "merge";
  readonly amount: number;
}

/** The storage-cap warning, not a silent drop (GUARDRAILS.md, chunk 16). */
export interface CoinOverflowDiscardedEvent extends LedgerEventBase {
  readonly kind: "coin_overflow_discarded";
  readonly source: CoinEarnSource;
  readonly amountDiscarded: number;
}

export interface UnitMergedEvent extends LedgerEventBase {
  readonly kind: "unit_merged";
  readonly recipe: MergeRecipeKind;
  readonly consumedUnitInstanceIds: readonly string[];
  readonly producedUnitInstanceIds: readonly string[];
  readonly targetLevel: number;
  readonly coinCost: number;
}

export type LedgerEvent = CoinEarnedEvent | CoinSpentEvent | CoinOverflowDiscardedEvent | UnitMergedEvent;

/**
 * Coin balance rebuilt from zero by replaying the log — the "balance is a
 * projection" guarantee (chunk 02 / chunk 16 DoD). Must match the live
 * balance produced incrementally by CoinService exactly.
 */
export function rebuildCoinBalance(events: readonly LedgerEvent[], accountId: string): number {
  let balance = 0;
  for (const event of events) {
    if (event.accountId !== accountId) continue;
    if (event.kind === "coin_earned") balance += event.amountApplied;
    else if (event.kind === "coin_spent") balance -= event.amount;
  }
  return balance;
}
