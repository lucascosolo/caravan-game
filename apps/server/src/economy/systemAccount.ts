/**
 * Chunk 25 / PHASE-2 §25: a system account (account.is_system — the non-player owner of
 * an authored standing party) can never be credited Coin. Coin a caravan loses to an
 * authored party is DESTROYED, and Coin an authored party would "earn" is never minted.
 * Every credit path (appendCoinCredits, creditPartyWin, creditBankedTrip, the trickle)
 * refuses with this error; the ledger trigger in migration 011 is the storage backstop.
 * Chunk 19 must route is_system owners around the credit (destroy + record), not catch this.
 */
export class SystemAccountCreditError extends Error {
  constructor(public readonly accountId: string) {
    super(`account ${accountId} is a system account and can never be credited Coin: Coin lost to an authored party is destroyed, not banked`);
    this.name = "SystemAccountCreditError";
  }
}
