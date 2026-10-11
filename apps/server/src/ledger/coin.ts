/**
 * Coin movements through the ledger. Credits are clamped to the account's storage cap
 * INSIDE the append transaction (account row locked), and the event records both the
 * amount actually credited and what the cap discarded, so the log alone reproduces the
 * balance. Chunk 16 builds the economy on these; chunk 19 uses the transfer variant.
 */
import type pg from "pg";
import type { CoinPayload, LedgerEventDraft, LedgerEventType } from "./events.js";
import { lockAccountForAppend } from "./ledger.js";

type CoinCreditType = Extract<LedgerEventType, "coin_earned" | "coin_purchased" | "coin_transferred_to_defender">;

function assertNonNegInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
}

/**
 * Build a credit draft clamped to the cap. Must run inside the transaction that will
 * append it; it takes the account append lock and reads the live balance.
 */
export async function coinCreditDraft(
  client: pg.PoolClient,
  input: { type: CoinCreditType; accountId: string; amount: number; reason: string; extra?: Record<string, string | number> },
): Promise<LedgerEventDraft & { payload: CoinPayload }> {
  assertNonNegInt("amount", input.amount);
  await lockAccountForAppend(client, input.accountId);
  const res = await client.query<{ coin_balance: number; coin_storage_cap: number }>(
    "SELECT coin_balance, coin_storage_cap FROM account WHERE id = $1 FOR UPDATE",
    [input.accountId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`account ${input.accountId} not found`);
  const room = Math.max(0, row.coin_storage_cap - row.coin_balance);
  const amount = Math.min(input.amount, room);
  const payload: CoinPayload = { ...(input.extra ?? {}), amount, reason: input.reason };
  if (amount < input.amount) payload.overflowDiscarded = input.amount - amount;
  return { type: input.type, accountId: input.accountId, payload };
}

/** Build a debit draft. The account CHECK (coin_balance >= 0) refuses overdraft at commit. */
export function coinDebitDraft(input: {
  accountId: string;
  amount: number;
  reason: string;
  extra?: Record<string, string | number>;
}): LedgerEventDraft & { payload: CoinPayload } {
  assertNonNegInt("amount", input.amount);
  return {
    type: "coin_spent",
    accountId: input.accountId,
    payload: { ...(input.extra ?? {}), amount: input.amount, reason: input.reason },
  };
}
