/**
 * The passive trickle (chunk 16): COIN_TRICKLE_RATE_PER_HOUR up to the storage cap, so a
 * player who never rides out still has something accumulating — and therefore at risk the
 * moment they do. There is NO background tick in this architecture: the trickle is
 * computed lazily from elapsed time whenever the balance is read, and materialized as a
 * `coin_earned` event (reason `trickle`) so the ledger stays the whole story.
 *
 * Deterministic and read-frequency independent: accrual happens in whole coins, one per
 * COIN_TRICKLE_MS_PER_COIN ms, and the accrual point advances only by the time those
 * coins consumed. The remainder is carried, so reading ten times in an hour yields exactly
 * what one read at the end of the hour would. The accrual point itself lives in the
 * ledger (payload.accruedThroughMs of the last trickle event), not in a column, so a
 * rebuild from the log reproduces it and nothing but an event can move it.
 *
 * At the cap the trickle CEASES: coins the cap cannot hold are recorded as
 * `overflowDiscarded` and the accrual point jumps to now, so time spent at the cap never
 * banks a backlog that would land in one lump after the next spend.
 */
import { TUNABLES } from "@caravan/content";
import type pg from "pg";
import { withTransaction, type Queryable } from "../db/pool.js";
import type { CoinPayload, LedgerEventDraft } from "../ledger/events.js";
import { appendEvents, lockAccountForAppend } from "../ledger/ledger.js";

export const TRICKLE_REASON = "trickle";

export interface TrickleComputation {
  /** Whole coins the elapsed time produced. 0 => nothing to write. */
  coins: number;
  credited: number;
  discarded: number;
  accruedFromMs: number;
  /** Where the next computation starts from. */
  accruedThroughMs: number;
  /** Milliseconds until the next whole coin would accrue, from `nowMs`. */
  nextCoinInMs: number;
}

/** Pure. Same inputs → same output; no clock inside. */
export function computeTrickle(input: { accruedFromMs: number; nowMs: number; balance: number; cap: number }): TrickleComputation {
  const { accruedFromMs, nowMs, balance, cap } = input;
  for (const [k, v] of Object.entries(input)) {
    if (!Number.isInteger(v)) throw new RangeError(`computeTrickle: ${k} must be an integer, got ${String(v)}`);
  }
  const msPerCoin = TUNABLES.COIN_TRICKLE_MS_PER_COIN;
  const elapsed = Math.max(0, nowMs - accruedFromMs);
  const coins = Math.floor(elapsed / msPerCoin);
  const room = Math.max(0, cap - balance);
  const credited = Math.min(coins, room);
  const discarded = coins - credited;
  // Carry the remainder unless the cap swallowed something — then the clock restarts now.
  const accruedThroughMs = coins === 0 ? accruedFromMs : discarded > 0 ? nowMs : accruedFromMs + coins * msPerCoin;
  const nextCoinInMs = Math.max(0, accruedThroughMs + msPerCoin - nowMs);
  return { coins, credited, discarded, accruedFromMs, accruedThroughMs, nextCoinInMs };
}

/** The accrual point: the last trickle event's `accruedThroughMs`, else account creation. */
export async function readTrickleAccrualPoint(db: Queryable, accountId: string): Promise<number> {
  const last = await db.query<{ payload: CoinPayload & { accruedThroughMs?: number } }>(
    `SELECT payload FROM ledger_event
     WHERE account_id = $1 AND event_type = 'coin_earned' AND payload->>'reason' = $2
     ORDER BY seq DESC LIMIT 1`,
    [accountId, TRICKLE_REASON],
  );
  const through = last.rows[0]?.payload.accruedThroughMs;
  if (typeof through === "number" && Number.isInteger(through)) return through;
  const created = await db.query<{ created_ms: string }>(
    "SELECT (floor(extract(epoch FROM created_at) * 1000))::text AS created_ms FROM account WHERE id = $1",
    [accountId],
  );
  const row = created.rows[0];
  if (!row) throw new Error(`account ${accountId} not found`);
  return Number(row.created_ms);
}

export interface TrickleAccrual extends TrickleComputation {
  balance: number;
  cap: number;
  ratePerHour: number;
  msPerCoin: number;
  atCap: boolean;
}

/**
 * Accrue inside the caller's transaction, under the account append lock. Returns the
 * post-accrual balance. `nowMs` is injectable so tests drive the clock; the server passes
 * the wall clock, which is the ONLY place time enters the economy.
 */
export async function accrueTrickleTx(client: pg.PoolClient, accountId: string, nowMs: number): Promise<TrickleAccrual> {
  await lockAccountForAppend(client, accountId);
  const acct = await client.query<{ coin_balance: number; coin_storage_cap: number }>(
    "SELECT coin_balance, coin_storage_cap FROM account WHERE id = $1 FOR UPDATE",
    [accountId],
  );
  const row = acct.rows[0];
  if (!row) throw new Error(`account ${accountId} not found`);
  const accruedFromMs = await readTrickleAccrualPoint(client, accountId);
  const calc = computeTrickle({ accruedFromMs, nowMs, balance: row.coin_balance, cap: row.coin_storage_cap });
  let balance = row.coin_balance;
  if (calc.coins > 0) {
    const payload: CoinPayload = {
      amount: calc.credited,
      reason: TRICKLE_REASON,
      coins: calc.coins,
      accruedFromMs: calc.accruedFromMs,
      accruedThroughMs: calc.accruedThroughMs,
    };
    if (calc.discarded > 0) payload.overflowDiscarded = calc.discarded;
    const draft: LedgerEventDraft = { type: "coin_earned", accountId, payload };
    // Deterministic causation: the same accrual window can only ever be written once.
    await appendEvents(client, `trickle:${accountId}:${calc.accruedFromMs}`, [draft]);
    balance += calc.credited;
  }
  return {
    ...calc,
    balance,
    cap: row.coin_storage_cap,
    ratePerHour: TUNABLES.COIN_TRICKLE_RATE_PER_HOUR,
    msPerCoin: TUNABLES.COIN_TRICKLE_MS_PER_COIN,
    atCap: balance >= row.coin_storage_cap,
  };
}

/** Accrue in its own transaction. The read path for "what is my balance right now". */
export async function accrueTrickle(pool: pg.Pool, accountId: string, nowMs: number = Date.now()): Promise<TrickleAccrual> {
  return withTransaction(pool, (client) => accrueTrickleTx(client, accountId, nowMs));
}
