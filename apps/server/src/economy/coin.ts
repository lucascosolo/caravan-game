/**
 * Coin: the earn paths and the cap (chunk 16). Coin is ACCOUNT-level (GUARDRAILS §5) and
 * every movement is a ledger event; `account.coin_balance` is only ever the projection the
 * ledger trigger maintains. Nothing here reads any account state beyond Coin itself
 * — Coin buys pace, never power, and this module cannot tell a paying account from a free
 * one (GUARDRAILS §2).
 *
 * The earn math is pure and integer-only so the schedule a player is shown before a trip
 * is exactly what the ledger will record afterward (GUARDRAILS §4).
 *
 * Who calls what:
 *   chunk 15 (trip loop)  -> creditBankedTrip     when a trip banks; per-encounter Coin is
 *                            UNBANKED trip state until then (bounded stakes), so there is
 *                            deliberately no "credit one encounter now" path.
 *   chunk 19 (loss)       -> appendCoinCredits (coin_transferred_to_party_owner) for the
 *                            overrun transfer, sized from the trip's accrued (floored) rows.
 *   chunk 09/13 (party)   -> creditPartyWin        when a standing party overruns a caravan
 *                            (chunk 19 QA D1: the trip loop's overrun appends `partyWinCredit`
 *                            in the transfer batch, under `transfer:<jobId>`).
 *   chunk 17 (home town)  -> readCoinBalance, overflowForecast, and trickle.ts.
 *   anything that DEBITS  -> spendCoin. This is the ONLY debit path (QA S5): it flushes the
 *                            pending trickle first, so the balance a debit is checked against
 *                            is the balance the player was shown, and no pending coin is
 *                            lost when the debit moves the trickle's accrual point. Nothing
 *                            outside this module may build a `coin_spent` draft directly
 *                            (ledger/coin.ts's `coinDebitDraft` is imported here and
 *                            nowhere else — a test enforces it).
 */
import { TUNABLES, scaleInt } from "@caravan/content";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import { coinDebitDraft } from "../ledger/coin.js";
import type { CoinCreditEventType, CoinPayload, JsonObject, LedgerEventDraft, LedgerEventRow } from "../ledger/events.js";
import { appendEvents, lockAccountForAppend } from "../ledger/ledger.js";
import { conflict } from "../services/errors.js";
import { SystemAccountCreditError } from "./systemAccount.js";
import { TRICKLE_REASON, accrueTrickleTx, type TrickleAccrual } from "./trickle.js";

// ─────────────────────────────────────────────────────────────────────────────────────────
// Pure earn math. Integers in, integers out, no clock.
// ─────────────────────────────────────────────────────────────────────────────────────────

function assertPosInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer, got ${String(v)}`);
}

/**
 * One escalation step of the schedule, clamped at the storage cap (QA N4): no single
 * encounter can be worth more than the account could hold, and the geometric series can
 * never leave the safe-integer range however long a trip runs.
 */
function nextEncounterCoin(amount: number): number {
  const next = Math.min(scaleInt(amount, TUNABLES.COIN_ENCOUNTER_ESCALATION_MULT), TUNABLES.COIN_STORAGE_CAP);
  if (!Number.isSafeInteger(next)) throw new RangeError("encounter Coin schedule left the safe-integer range");
  return next;
}

/** Chunk 19 QA D2a: basis points of the base schedule each display band adds. */
export const COIN_ENCOUNTER_BAND_SCALE_BP: number = TUNABLES.COIN_ENCOUNTER_BAND_SCALE_BP;
if (!Number.isInteger(COIN_ENCOUNTER_BAND_SCALE_BP) || COIN_ENCOUNTER_BAND_SCALE_BP < 0) throw new Error("TUNABLES.COIN_ENCOUNTER_BAND_SCALE_BP must be a non-negative integer");

function assertBand(band: number): void {
  if (!Number.isInteger(band) || band < 0) throw new RangeError(`band must be a non-negative integer (a display band index), got ${String(band)}`);
}

/**
 * Scale one base-schedule amount by the caravan's living display band (chunk 19 QA D2a):
 * floor(amount × (10 000 + band × COIN_ENCOUNTER_BAND_SCALE_BP) / 10 000), clamped at the
 * storage cap. Integer only.
 */
function scaleByBand(amount: number, band: number): number {
  assertBand(band);
  const scaled = Math.floor((amount * (10_000 + band * COIN_ENCOUNTER_BAND_SCALE_BP)) / 10_000);
  if (!Number.isSafeInteger(scaled)) throw new RangeError("band-scaled encounter Coin left the safe-integer range");
  return Math.min(scaled, TUNABLES.COIN_STORAGE_CAP);
}

/**
 * Coin for surviving the Nth encounter of a trip (1-based) for a caravan in living display
 * band `band` (matchmaking/band.ts bandOf(rating).index): the base schedule — BASE at
 * encounter 1, then ×COIN_ENCOUNTER_ESCALATION_MULT per subsequent encounter, floored at each
 * step (400, 539, 727, 981, 1323, 1785, ...; clamped at COIN_STORAGE_CAP from encounter 18) —
 * times (1 + band × COIN_ENCOUNTER_BAND_SCALE_BP / 10 000), floored, clamped at the cap.
 * Band 0 is the base schedule; REPUTATION_START (1000) is band 3: 1000, 1347, 1817, … .
 * The trip loop reads `band` from the encounter's chosen menu row and stores the result.
 */
export function coinForEncounter(encounterIndex: number, band: number): number {
  assertPosInt("encounterIndex", encounterIndex);
  let amount: number = TUNABLES.COIN_PER_ENCOUNTER_BASE;
  for (let i = 2; i <= encounterIndex; i++) amount = nextEncounterCoin(amount);
  return scaleByBand(amount, band);
}

/** The per-encounter schedule for the first `count` encounters at display band `band`, for previews. */
export function encounterCoinSchedule(count: number, band: number): number[] {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`count must be a non-negative integer, got ${String(count)}`);
  assertBand(band);
  const out: number[] = [];
  let amount: number = TUNABLES.COIN_PER_ENCOUNTER_BASE;
  for (let i = 1; i <= count; i++) {
    out.push(scaleByBand(amount, band));
    amount = nextEncounterCoin(amount);
  }
  return out;
}

/** Total encounter Coin a trip in band `band` has accrued (unbanked, at full earn) after surviving `n` encounters. */
export function coinForEncountersSurvived(n: number, band: number): number {
  const total = encounterCoinSchedule(n, band).reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError("encounter Coin total left the safe-integer range");
  return total;
}

/**
 * The delivery reward for banking after `n` survived encounters (chunk 15 QA D1):
 * COIN_DELIVERY_PER_ENCOUNTER × n, no flat bonus.
 */
export function coinForDelivery(encountersSurvived: number): number {
  if (!Number.isInteger(encountersSurvived) || encountersSurvived < 0) throw new RangeError("encountersSurvived must be a non-negative integer");
  return TUNABLES.COIN_DELIVERY_PER_ENCOUNTER * encountersSurvived;
}

/** Everything a trip in band `band` that banks after `n` survived encounters is worth at full earn: encounters + delivery (the delivery does not scale with the band). */
export function coinForBankedTrip(encountersSurvived: number, band: number): number {
  return coinForEncountersSurvived(encountersSurvived, band) + coinForDelivery(encountersSurvived);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The cap. Credits never pass it; what the cap swallows is recorded, never silent.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The pre-trip overflow warning. It is "as of now": `room` is how much the account can hold
 * RIGHT NOW, not how much it will hold when the trip banks (the trickle keeps filling the
 * store meanwhile). Word any UI text that way — "room right now" — never as a promise.
 */
export interface OverflowForecast {
  balance: number;
  cap: number;
  /** How much more Coin the account can hold right now. */
  room: number;
  prospectiveEarn: number;
  /** What would land in the balance if `prospectiveEarn` were credited now. */
  wouldCredit: number;
  /** What the cap would discard. Non-zero => surface a warning BEFORE the trip. */
  wouldDiscard: number;
  atCap: boolean;
}

/** Pure: what happens if `prospectiveEarn` Coin were credited against this balance and cap. */
export function overflowForecast(balance: number, cap: number, prospectiveEarn: number): OverflowForecast {
  if (!Number.isSafeInteger(prospectiveEarn) || prospectiveEarn < 0) throw new RangeError("prospectiveEarn must be a non-negative safe integer");
  const room = Math.max(0, cap - balance);
  const wouldCredit = Math.min(prospectiveEarn, room);
  return { balance, cap, room, prospectiveEarn, wouldCredit, wouldDiscard: prospectiveEarn - wouldCredit, atCap: room === 0 };
}

export interface CoinBalance {
  balance: number;
  cap: number;
}

export async function readCoinBalance(db: Queryable, accountId: string): Promise<CoinBalance> {
  const res = await db.query<{ coin_balance: number; coin_storage_cap: number }>(
    "SELECT coin_balance, coin_storage_cap FROM account WHERE id = $1",
    [accountId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`account ${accountId} not found`);
  return { balance: row.coin_balance, cap: row.coin_storage_cap };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Credits. One batch, one causation, one running clamp.
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface CoinCreditSpec {
  amount: number;
  reason: string;
  /** Extra payload fields (plain JSON, integers only). */
  extra?: JsonObject;
  /**
   * The credit event type, default `coin_earned`. Every member of COIN_CREDIT_TYPES folds
   * into the balance the same way and is clamped the same way; the type only names the
   * source (earned / transferred / the store's). The clamp cannot tell them apart.
   */
  type?: CoinCreditEventType;
}

export { SystemAccountCreditError };

export interface CoinCreditResult {
  rows: LedgerEventRow[];
  /** Sum actually applied to the balance. */
  credited: number;
  /** Sum the cap discarded (recorded on each event as `overflowDiscarded`). */
  discarded: number;
  balanceAfter: number;
  cap: number;
}

/**
 * Append several credit events (`coin_earned` unless a spec says otherwise) under one causation id, clamped to the cap as a
 * BATCH: the room is read once under the account lock and consumed by each credit in
 * order, so a batch can never overshoot the cap even though each event is clamped
 * individually. (ledger/coin.ts's `coinCreditDraft` clamps one draft against the live
 * balance; two such drafts in one append would each see the pre-batch room.)
 *
 * Runs inside the caller's transaction. The `(causation_id, causation_seq)` uniqueness
 * backstop makes a retried cause fail rather than double-credit.
 */
export async function appendCoinCredits(
  client: pg.PoolClient,
  input: { causationId: string; accountId: string; credits: readonly CoinCreditSpec[] },
): Promise<CoinCreditResult> {
  for (const c of input.credits) {
    if (!Number.isInteger(c.amount) || c.amount < 0) throw new RangeError(`credit amount must be a non-negative integer, got ${String(c.amount)}`);
    // The trickle's accrual point is read back from its own events (QA N3): only
    // trickle.ts may write a `trickle` row, or a caller could move the point by hand.
    if (c.reason === TRICKLE_REASON) throw new RangeError(`reason '${TRICKLE_REASON}' is reserved for the trickle itself`);
  }
  await lockAccountForAppend(client, input.accountId);
  const res = await client.query<{ coin_balance: number; coin_storage_cap: number; is_system: boolean }>(
    "SELECT coin_balance, coin_storage_cap, is_system FROM account WHERE id = $1 FOR UPDATE",
    [input.accountId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`account ${input.accountId} not found`);
  if (row.is_system) throw new SystemAccountCreditError(input.accountId);
  let room = Math.max(0, row.coin_storage_cap - row.coin_balance);
  let credited = 0;
  let discarded = 0;
  const drafts: (LedgerEventDraft & { payload: CoinPayload })[] = [];
  for (const c of input.credits) {
    const amount = Math.min(c.amount, room);
    room -= amount;
    credited += amount;
    const payload: CoinPayload = { ...(c.extra ?? {}), amount, reason: c.reason };
    if (amount < c.amount) {
      payload.overflowDiscarded = c.amount - amount;
      discarded += c.amount - amount;
    }
    drafts.push({ type: c.type ?? "coin_earned", accountId: input.accountId, payload });
  }
  const rows = drafts.length ? await appendEvents(client, input.causationId, drafts) : [];
  return { rows, credited, discarded, balanceAfter: row.coin_balance + credited, cap: row.coin_storage_cap };
}

/**
 * A trip banked: credit one `coin_earned` per survived encounter (reason
 * `encounter_survived`, in encounter order) and then the delivery (`trip_banked`,
 * COIN_DELIVERY_PER_ENCOUNTER × encounters survived).
 * Per-encounter Coin was unbanked — at risk — until this moment; it enters the account
 * balance only here. Chunk 15 calls this in the same transaction as its `trip_banked`
 * event, with the trip's deterministic causation id.
 */
export async function creditBankedTrip(
  client: pg.PoolClient,
  input: {
    accountId: string;
    causationId: string;
    tripId: string;
    encountersSurvived: number;
    /**
     * Chunk 19: the Coin each survived encounter actually accrued (the schedule passed through
     * the sandbagging earn floor, trip/stakes.ts `applyEarnFloor`), in encounter order. When
     * omitted, the unfloored band-0 base schedule (chunk 16's original contract; the trip loop
     * always passes the stored amounts).
     */
    encounterCoin?: readonly number[];
  },
): Promise<CoinCreditResult> {
  if (!Number.isInteger(input.encountersSurvived) || input.encountersSurvived < 0) {
    throw new RangeError("encountersSurvived must be a non-negative integer");
  }
  const amounts = input.encounterCoin ?? encounterCoinSchedule(input.encountersSurvived, 0);
  if (amounts.length !== input.encountersSurvived) throw new RangeError(`encounterCoin names ${amounts.length} encounters, not ${input.encountersSurvived}`);
  const credits: CoinCreditSpec[] = amounts.map((amount, i) => ({
    amount,
    reason: "encounter_survived",
    extra: { tripId: input.tripId, encounterIndex: i + 1 },
  }));
  credits.push({ amount: coinForDelivery(input.encountersSurvived), reason: "trip_banked", extra: { tripId: input.tripId, encountersSurvived: input.encountersSurvived } });
  return appendCoinCredits(client, { causationId: input.causationId, accountId: input.accountId, credits });
}

/**
 * The party-win credit as a spec (chunk 19 QA D1), so the overrun can append it in the SAME
 * batch as the Coin transfer — one causation id (`transfer:<jobId>`), one running clamp under
 * the owner's headroom (trip/stakes.ts applyOverrunLosses). COIN_PER_PARTY_WIN, reason
 * `party_win`, a plain `coin_earned`.
 */
export function partyWinCredit(input: { tripId: string; encounterIndex: number; jobId?: string }): CoinCreditSpec {
  assertPosInt("encounterIndex", input.encounterIndex);
  return {
    amount: TUNABLES.COIN_PER_PARTY_WIN,
    reason: "party_win",
    extra: { tripId: input.tripId, encounterIndex: input.encounterIndex, ...(input.jobId ? { jobId: input.jobId } : {}) },
  };
}

/**
 * Chunk 15 QA S4: the party owner's depth-scaled loot for a HELD fight (the caravan wiped the
 * party), as a spec. `amount` is the outcome's reported `loot` (trip/loot.ts) — the trip loop
 * credits exactly that, under `transfer:<jobId>` like chunk 19's overrun credits, capped by the
 * owner's headroom (the clamp records `overflowDiscarded`). Reason `party_loot`, a plain
 * `coin_earned`. Never on an overrun (the transfer + party win are what that fight earns) or a
 * stalemate, and never to a system owner.
 */
export function partyLootCredit(input: { tripId: string; encounterIndex: number; jobId: string; amount: number; depth: number }): CoinCreditSpec {
  assertPosInt("encounterIndex", input.encounterIndex);
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new RangeError(`loot must be a non-negative integer, got ${String(input.amount)}`);
  return { amount: input.amount, reason: "party_loot", extra: { tripId: input.tripId, encounterIndex: input.encounterIndex, jobId: input.jobId, depth: input.depth } };
}

/**
 * The passive side's earn path: the owner of a standing party whose party overran a
 * caravan. The owner was never present; their party lost nothing (GUARDRAILS §0). Standalone
 * form (its own causation id); the trip loop's overrun pays it through `partyWinCredit` in the
 * transfer batch instead (chunk 19 QA D1).
 */
export async function creditPartyWin(
  client: pg.PoolClient,
  input: { accountId: string; causationId: string; tripId: string; encounterIndex: number },
): Promise<CoinCreditResult> {
  return appendCoinCredits(client, {
    causationId: input.causationId,
    accountId: input.accountId,
    credits: [partyWinCredit({ tripId: input.tripId, encounterIndex: input.encounterIndex })],
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Debits. Exactly one path (QA S5): accrue, then debit.
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface SpendCoinOptions {
  /** The cause this debit (and any `alongside` events) commit under. Required. */
  causationId: string;
  /** Extra payload fields on the `coin_spent` event (what was bought). */
  extra?: Record<string, string | number>;
  /**
   * Events to append in the SAME batch, after the debit, under the same causation id
   * (e.g. the `unit_merged` the Coin was spent on). Appended only if the debit goes through.
   */
  alongside?: readonly LedgerEventDraft[];
}

export interface SpendCoinResult {
  /** The trickle flush that ran before the debit. `trickle.balance` is what was checked. */
  trickle: TrickleAccrual;
  /** `coin_spent` first, then `alongside` in order. */
  events: LedgerEventRow[];
  balanceBefore: number;
  balanceAfter: number;
}

/**
 * The only way Coin leaves an account. Inside the caller's transaction and under the
 * account append lock:
 *   1. flush the pending trickle (forced — every whole coin earned so far is written, so
 *      the debit's `occurred_at`, which becomes the new accrual point, drops nothing but a
 *      sub-coin remainder);
 *   2. refuse with 409 `insufficient_coin` if the flushed balance is below `amount`
 *      (the account CHECK is the backstop, never the mechanism);
 *   3. append `coin_spent` (+ `alongside`) under `causationId`.
 * `nowMs` is the caller's clock (injectable); the server passes the wall clock.
 */
export async function spendCoin(
  client: pg.PoolClient,
  accountId: string,
  amount: number,
  reason: string,
  nowMs: number,
  opts: SpendCoinOptions,
): Promise<SpendCoinResult> {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError(`debit amount must be a non-negative integer, got ${String(amount)}`);
  if (!reason) throw new TypeError("reason is required");
  if (!opts.causationId) throw new TypeError("causationId is required");
  await lockAccountForAppend(client, accountId);
  const trickle = await accrueTrickleTx(client, accountId, nowMs, { force: true });
  // Forced: nothing is pending now, so the ledger balance IS the balance shown.
  const balanceBefore = trickle.ledgerBalance;
  if (balanceBefore < amount) {
    throw conflict("insufficient_coin", `${reason} costs ${amount} Coin; balance is ${balanceBefore}`);
  }
  const debit = coinDebitDraft({ accountId, amount, reason, ...(opts.extra ? { extra: opts.extra } : {}) });
  const drafts: LedgerEventDraft[] = [debit, ...(opts.alongside ?? [])];
  const events = await appendEvents(client, opts.causationId, drafts);
  return { trickle, events, balanceBefore, balanceAfter: balanceBefore - amount };
}
