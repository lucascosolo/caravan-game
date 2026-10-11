/**
 * Coin movements through the ledger. Credits are clamped to the account's storage cap
 * INSIDE the append transaction (account row locked), and the event records both the
 * amount actually credited and what the cap discarded, so the log alone reproduces the
 * balance. Chunk 16 builds the economy on these; chunk 19 uses the transfer variant.
 *
 * LOCK ORDER (QA-02 S5). Nothing here takes an account lock. A transaction that credits
 * Coin takes every account lock it will need FIRST, in sorted order, with
 * `lockAccountsForAppend(client, ids)`, and only then builds drafts. `coinCreditDraft`
 * asserts that the lock is already held and fails loudly otherwise, because taking it
 * here (as it once did) ordered locks by call order rather than by id and could deadlock
 * against a multi-account `appendEvents` holding the mirror image.
 */
import type pg from "pg";
import { COIN_CREDIT_TYPES, type CoinCreditEventType as CoinCreditType, type CoinPayload, type LedgerEventDraft } from "./events.js";
import { assertAccountAppendLockHeld } from "./ledger.js";

function assertNonNegInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
}

async function readRoom(client: pg.PoolClient, accountId: string): Promise<number> {
  const res = await client.query<{ coin_balance: number; coin_storage_cap: number }>(
    "SELECT coin_balance, coin_storage_cap FROM account WHERE id = $1 FOR UPDATE",
    [accountId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`account ${accountId} not found`);
  return Math.max(0, row.coin_storage_cap - row.coin_balance);
}

/**
 * Build a credit draft clamped to the cap. Must run inside the transaction that will
 * append it, AFTER that transaction took the account's append lock (asserted); it reads
 * the live balance under the row lock.
 */
export async function coinCreditDraft(
  client: pg.PoolClient,
  input: { type: CoinCreditType; accountId: string; amount: number; reason: string; extra?: Record<string, string | number> },
): Promise<LedgerEventDraft & { payload: CoinPayload }> {
  assertNonNegInt("amount", input.amount);
  await assertAccountAppendLockHeld(client, input.accountId, "coinCreditDraft");
  const room = await readRoom(client, input.accountId);
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

/**
 * Commit-time clamp (QA-02 S6). A pure job handler cannot see a balance, so it emits
 * credits at the REQUESTED amount; the worker runs this inside the completion transaction
 * (every account lock already held, asserted) to clamp each credit to the room left, in
 * draft order, consuming the room as it goes. The committed event carries the applied
 * `amount` and `overflowDiscarded` = requested - applied, so:
 *
 *     committed stream == handler stream, with each credit's amount clamped and the
 *                         overflow recorded; nothing else differs.
 *
 * verifyJobReplay compares on the requested amount (amount + overflowDiscarded), which
 * is the deterministic part; what the cap swallowed depends on the balance at commit.
 * Non-credit drafts pass through untouched. Drafts that already carry overflowDiscarded
 * (a writer that clamped under the lock itself) are treated as requesting
 * amount + overflowDiscarded, so clamping is idempotent.
 */
export async function clampCoinCreditDrafts(client: pg.PoolClient, drafts: readonly LedgerEventDraft[]): Promise<LedgerEventDraft[]> {
  const room = new Map<string, number>();
  const out: LedgerEventDraft[] = [];
  for (const d of drafts) {
    if (!COIN_CREDIT_TYPES.has(d.type)) {
      out.push(d);
      continue;
    }
    const applied = d.payload["amount"];
    const discarded = d.payload["overflowDiscarded"] ?? 0;
    if (typeof applied !== "number" || typeof discarded !== "number") throw new TypeError(`coin credit '${d.type}' has no integer amount`);
    assertNonNegInt("amount", applied);
    assertNonNegInt("overflowDiscarded", discarded);
    const requested = applied + discarded;
    let left = room.get(d.accountId);
    if (left === undefined) {
      await assertAccountAppendLockHeld(client, d.accountId, "clampCoinCreditDrafts");
      left = await readRoom(client, d.accountId);
    }
    const amount = Math.min(requested, left);
    room.set(d.accountId, left - amount);
    const payload: CoinPayload = { ...(d.payload as CoinPayload), amount };
    delete payload.overflowDiscarded;
    if (amount < requested) payload.overflowDiscarded = requested - amount;
    out.push({ ...d, payload });
  }
  return out;
}

/** The amount a credit event asked for before the cap: amount + overflowDiscarded. */
export function requestedCreditAmount(payload: CoinPayload): number {
  return payload.amount + (payload.overflowDiscarded ?? 0);
}
