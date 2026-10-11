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
 * what one read at the end of the hour would.
 *
 * Display vs. materialize (QA S4): every read COMPUTES the pending coins and the balance
 * the player sees is `ledger balance + pending`. A ledger row is written only once
 * TRICKLE_MATERIALIZE_MIN_COINS have accrued or TRICKLE_MATERIALIZE_MIN_MS have passed
 * (or when a debit forces a flush — see `spendCoin` in coin.ts), so polling the balance
 * cannot grow the ledger one row per 18 s. Pending coins are never dropped by a read.
 *
 * The accrual point is ledger-derived, never a column:
 *   max( last valid trickle event's `accruedThroughMs`, last `coin_spent`'s `occurred_at` ).
 * At the cap NOTHING is written (no zero-amount rows); the point simply stays put. The
 * next spend moves the point to the spend itself, so idling at the cap never banks a
 * backlog that would land in one lump after the next merge. (A spend also drops any
 * sub-coin remainder — under 18 s — which the forced flush before the debit bounds.)
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
  /** Of `coins`, what the cap has room for — what a materialization would credit. */
  credited: number;
  /** Of `coins`, what the cap would discard. */
  discarded: number;
  elapsedMs: number;
  accruedFromMs: number;
  /** Where the next computation starts from, if this one is materialized. */
  accruedThroughMs: number;
  /** Milliseconds until the next whole coin would accrue, from `nowMs`. */
  nextCoinInMs: number;
  /**
   * Whether a plain read should write this computation now: something to credit AND
   * (coins >= TRICKLE_MATERIALIZE_MIN_COINS or elapsed >= TRICKLE_MATERIALIZE_MIN_MS).
   * Nothing to credit (at the cap, or nothing accrued) => never.
   */
  shouldMaterialize: boolean;
}

/** Pure. Same inputs → same output; no clock inside. */
export function computeTrickle(input: { accruedFromMs: number; nowMs: number; balance: number; cap: number }): TrickleComputation {
  const { accruedFromMs, nowMs, balance, cap } = input;
  for (const [k, v] of Object.entries(input)) {
    if (!Number.isInteger(v)) throw new RangeError(`computeTrickle: ${k} must be an integer, got ${String(v)}`);
  }
  const msPerCoin = TUNABLES.COIN_TRICKLE_MS_PER_COIN;
  const elapsedMs = Math.max(0, nowMs - accruedFromMs);
  const coins = Math.floor(elapsedMs / msPerCoin);
  const room = Math.max(0, cap - balance);
  const credited = Math.min(coins, room);
  const discarded = coins - credited;
  // Carry the remainder unless the cap swallowed something — then the clock restarts now.
  const accruedThroughMs = coins === 0 ? accruedFromMs : discarded > 0 ? nowMs : accruedFromMs + coins * msPerCoin;
  const nextCoinInMs = Math.max(0, accruedThroughMs + msPerCoin - nowMs);
  const shouldMaterialize =
    credited > 0 && (coins >= TUNABLES.TRICKLE_MATERIALIZE_MIN_COINS || elapsedMs >= TUNABLES.TRICKLE_MATERIALIZE_MIN_MS);
  return { coins, credited, discarded, elapsedMs, accruedFromMs, accruedThroughMs, nextCoinInMs, shouldMaterialize };
}

/**
 * The accrual point: max(last VALID trickle event's `accruedThroughMs`, last `coin_spent`
 * `occurred_at`), else account creation. A trickle row whose `accruedThroughMs` is missing
 * or not an integer is skipped in favour of the previous valid one (QA N3) — a malformed
 * row is never a reason to re-credit from account creation.
 */
export async function readTrickleAccrualPoint(db: Queryable, accountId: string): Promise<number> {
  const trickles = await db.query<{ through: string }>(
    `SELECT payload->>'accruedThroughMs' AS through FROM ledger_event
     WHERE account_id = $1 AND event_type = 'coin_earned' AND payload->>'reason' = $2
       AND jsonb_typeof(payload->'accruedThroughMs') = 'number'
     ORDER BY seq DESC LIMIT 20`,
    [accountId, TRICKLE_REASON],
  );
  let point: number | null = null;
  for (const r of trickles.rows) {
    const n = Number(r.through);
    if (Number.isSafeInteger(n)) {
      point = n;
      break;
    }
  }
  if (point === null) {
    const created = await db.query<{ created_ms: string }>(
      "SELECT (floor(extract(epoch FROM created_at) * 1000))::text AS created_ms FROM account WHERE id = $1",
      [accountId],
    );
    const row = created.rows[0];
    if (!row) throw new Error(`account ${accountId} not found`);
    point = Number(row.created_ms);
  }
  const spent = await db.query<{ spent_ms: string | null }>(
    `SELECT (floor(extract(epoch FROM max(occurred_at)) * 1000))::text AS spent_ms
     FROM ledger_event WHERE account_id = $1 AND event_type = 'coin_spent'`,
    [accountId],
  );
  const spentMs = spent.rows[0]?.spent_ms;
  if (spentMs !== null && spentMs !== undefined) point = Math.max(point, Number(spentMs));
  return point;
}

export interface TrickleAccrual extends TrickleComputation {
  /** `account.coin_balance` after this call — what the ledger holds. */
  ledgerBalance: number;
  /** Coins computed but not written (already clamped to the cap). 0 when materialized. */
  pending: number;
  /** What the player sees and what a merge is checked against: `ledgerBalance + pending`. */
  balance: number;
  /** True when this call wrote a trickle event. */
  materialized: boolean;
  cap: number;
  ratePerHour: number;
  msPerCoin: number;
  atCap: boolean;
}

function describeAccrual(calc: TrickleComputation, ledgerBalance: number, cap: number, materialized: boolean): TrickleAccrual {
  const pending = materialized ? 0 : calc.credited;
  const balance = ledgerBalance + pending;
  return {
    ...calc,
    ledgerBalance,
    pending,
    balance,
    materialized,
    cap,
    ratePerHour: TUNABLES.COIN_TRICKLE_RATE_PER_HOUR,
    msPerCoin: TUNABLES.COIN_TRICKLE_MS_PER_COIN,
    atCap: balance >= cap,
  };
}

/** Read-only: the trickle as of `nowMs` with no lock and no write (preview paths, QA S2). */
export async function peekTrickle(db: Queryable, accountId: string, nowMs: number): Promise<TrickleAccrual> {
  const acct = await db.query<{ coin_balance: number; coin_storage_cap: number }>(
    "SELECT coin_balance, coin_storage_cap FROM account WHERE id = $1",
    [accountId],
  );
  const row = acct.rows[0];
  if (!row) throw new Error(`account ${accountId} not found`);
  const accruedFromMs = await readTrickleAccrualPoint(db, accountId);
  const calc = computeTrickle({ accruedFromMs, nowMs, balance: row.coin_balance, cap: row.coin_storage_cap });
  return describeAccrual(calc, row.coin_balance, row.coin_storage_cap, false);
}

/**
 * Accrue inside the caller's transaction, under the account append lock. Writes a trickle
 * event only when `shouldMaterialize` (or `force`, which a debit uses to flush everything
 * pending before the debit moves the accrual point). At the cap nothing is ever written.
 * `nowMs` is injectable so tests drive the clock; the server passes the wall clock, which
 * is the ONLY place time enters the economy.
 */
export async function accrueTrickleTx(
  client: pg.PoolClient,
  accountId: string,
  nowMs: number,
  opts: { force?: boolean } = {},
): Promise<TrickleAccrual> {
  await lockAccountForAppend(client, accountId);
  const acct = await client.query<{ coin_balance: number; coin_storage_cap: number }>(
    "SELECT coin_balance, coin_storage_cap FROM account WHERE id = $1 FOR UPDATE",
    [accountId],
  );
  const row = acct.rows[0];
  if (!row) throw new Error(`account ${accountId} not found`);
  const accruedFromMs = await readTrickleAccrualPoint(client, accountId);
  const calc = computeTrickle({ accruedFromMs, nowMs, balance: row.coin_balance, cap: row.coin_storage_cap });
  const write = calc.credited > 0 && (calc.shouldMaterialize || opts.force === true);
  let ledgerBalance = row.coin_balance;
  if (write) {
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
    ledgerBalance += calc.credited;
  }
  return describeAccrual(calc, ledgerBalance, row.coin_storage_cap, write);
}

/** Accrue in its own transaction. The read path for "what is my balance right now". */
export async function accrueTrickle(pool: pg.Pool, accountId: string, nowMs: number = Date.now()): Promise<TrickleAccrual> {
  return withTransaction(pool, (client) => accrueTrickleTx(client, accountId, nowMs));
}
