/**
 * Buying a pack (chunk 20). One transaction, under the account's ledger append lock:
 *
 *   1. the offer is re-derived SERVER-SIDE from (current week, tier) — the client names the
 *      week it previewed and is refused (`offer_not_current`) if that week has rolled
 *      over, so what was shown is exactly what is granted (GUARDRAILS §4);
 *   2. the per-tier-per-week limit: a SETTLED prior row for (account, week, tier) means this
 *      exact purchase already happened — the call is a REPLAY (QA-20 D1, the chunk 16 S6
 *      convention): 200 `{ replayed: true }` with the stored purchase view and its stored
 *      `coin_purchased` event, and nothing moves. The UNIQUE constraint is the backstop under
 *      a race (23505 → the same replay); the advisory lock serializes honest callers so the
 *      second one sees the first's row rather than hitting the constraint;
 *   3. the fingerprint (QA-20 S2): if the client sent `contentsHash` — sha256 of the
 *      canonical contents it was SHOWN (`offerContentsHash`) — and what the server would grant
 *      now hashes differently, 409 `offer_changed` and nothing is written. A replay is
 *      answered before this check: the purchase already happened, and the stored view says
 *      exactly what it granted;
 *   4. RESERVE → CHARGE → CREDIT + SETTLE, in that order (QA-20 D2; the rule is written out
 *      in store/sandbox.ts): the `pack_purchase` row is inserted first as a reservation (its
 *      UNIQUE is our idempotency guard), the backend is charged with the purchase's
 *      `causationId` as its idempotency key, then the Coin is credited and the reservation
 *      is settled in place, once. A reservation found unsettled is RESUMED from the charge
 *      with the same key, granting the reservation's own recorded contents;
 *   5. before the credit, the pending trickle is FORCE-FLUSHED (QA-20 S1, mirroring
 *      `spendCoin`): `accrueTrickleTx(…, { force: true })` writes every coin the clock has
 *      produced, so the credit clamps against the balance the player was SHOWN (ledger +
 *      pending), not the bare ledger balance — otherwise a purchase that filled the store
 *      would silently eat the trickle the preview counted. The flush is surfaced as `trickle`;
 *   6. the Coin lands through chunk 16's `appendCoinCredits` as a `coin_purchased` event:
 *      clamped to the storage cap like every other credit, with `overflowDiscarded`
 *      recorded on the event and on the purchase row — the cap cannot be raced because the
 *      room is read under the same lock the credit is written under;
 *   7. cosmetics become account-level ownership rows (ON CONFLICT DO NOTHING: a cosmetic
 *      that rotates back is not granted twice; the response says which were already owned).
 *
 * THE LEDGER RECORD OF A COSMETIC GRANT (QA-20 N3). `coin_purchased`'s `payload.cosmetics`
 * lists the cosmetic ids the pack OFFERED — every one, including any the account already
 * owned (those are reported as `cosmeticsAlreadyOwned` and get no new row). Ownership is
 * therefore rebuilt from the ledger alone by the rule "the FIRST `coin_purchased` event (in
 * ledger order) naming an id owns it": that event's purchase is the one the
 * `cosmetic_ownership` row names. A regression test rebuilds ownership that way and compares.
 *
 * Nothing here reads anything but Coin and the account's own purchase rows; nothing here
 * writes to any caravan, roster, unlock, ladder or trip table — a source scan asserts it.
 */
import { TUNABLES, getCosmeticType, isPackTier, packOfferForWeek, weekIndexAt, type PackContent, type PackOffer, type PackTier } from "@caravan/content";
import type pg from "pg";
import { withTransaction, type Queryable } from "../db/pool.js";
import { appendCoinCredits, readCoinBalance, type CoinCreditResult } from "../economy/coin.js";
import { accrueTrickleTx } from "../economy/trickle.js";
import type { LedgerEventRow } from "../ledger/events.js";
import { listEventsByCausation, lockAccountForAppend } from "../ledger/ledger.js";
import { badRequest, conflict } from "../services/errors.js";
import { normalizePurchaseRow, offerContentsHash, purchaseView, type PurchaseRow } from "./offers.js";
import { SANDBOX_PURCHASE_BACKEND, type PurchaseBackend } from "./sandbox.js";

export const PURCHASE_REASON = "pack_purchase";

export function purchaseCausationId(accountId: string, weekIndex: number, tier: PackTier): string {
  return `pack:${accountId.toLowerCase()}:w${weekIndex}:t${tier}`;
}

export interface PurchasePackInput {
  accountId: string;
  tier: unknown;
  /** The week the client previewed. Must be the current week at `nowMs`. */
  weekIndex: unknown;
  /**
   * sha256 (lowercase hex) of the canonical contents the client was shown (QA-20 S2). When
   * given, a mismatch with what would be granted is 409 `offer_changed`. Optional here so
   * in-process callers can omit it; the HTTP route requires it.
   */
  contentsHash?: unknown;
  nowMs: number;
  backend?: PurchaseBackend;
}

/** The trickle flushed just before the credit (QA-20 S1). `credited` is what was written. */
export interface PurchaseTrickle {
  credited: number;
  discarded: number;
  materialized: boolean;
  accruedFromMs: number;
  accruedThroughMs: number;
  /** The ledger balance the purchase's credit was clamped against (after the flush). */
  balanceBeforeCredit: number;
}

export interface PurchasePackResult {
  /** True => this tier was already bought this week; the stored outcome is returned and nothing moved. */
  replayed: boolean;
  /** True => an unsettled reservation was found and completed (charge resumed with the same key). */
  resumed: boolean;
  purchase: ReturnType<typeof purchaseView>;
  offer: PackOffer;
  /** `balanceAfter` on a replay is the CURRENT balance, not a historical one. */
  coin: { requested: number; credited: number; discarded: number; balanceAfter: number; cap: number };
  /** Null on a replay: nothing was flushed by this call. */
  trickle: PurchaseTrickle | null;
  cosmeticsGranted: string[];
  cosmeticsAlreadyOwned: string[];
  events: LedgerEventRow[];
}

function parseTier(v: unknown): PackTier {
  if (!isPackTier(v)) throw badRequest("invalid_tier", "tier must be 1, 2 or 3");
  return v;
}

function parseWeek(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw badRequest("invalid_week", "weekIndex must be an integer (the week previewed)");
  return v;
}

const HASH_RE = /^[0-9a-f]{64}$/;
function parseContentsHash(v: unknown): string | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || !HASH_RE.test(v)) throw badRequest("invalid_contents_hash", "contentsHash must be the 64-character lowercase sha256 hex shown on the offer");
  return v;
}

function cosmeticIdsOf(contents: readonly PackContent[]): string[] {
  return contents.flatMap((c) => (c.kind === "cosmetic" ? [c.cosmeticId] : []));
}

function coinOf(contents: readonly PackContent[]): number {
  const coin = contents.filter((c): c is Extract<PackContent, { kind: "coin" }> => c.kind === "coin");
  if (coin.length !== 1) throw new Error(`pack contents must carry exactly one coin entry, got ${coin.length}`);
  return coin[0]!.amount;
}

async function selectPurchase(db: Queryable, accountId: string, weekIndex: number, tier: PackTier): Promise<PurchaseRow | null> {
  const res = await db.query<PurchaseRow>("SELECT * FROM pack_purchase WHERE account_id = $1 AND week_index = $2 AND tier = $3", [accountId, weekIndex, tier]);
  return res.rows[0] ? normalizePurchaseRow(res.rows[0]) : null;
}

export async function purchasePack(pool: pg.Pool, input: PurchasePackInput): Promise<PurchasePackResult> {
  const tier = parseTier(input.tier);
  const requestedWeek = parseWeek(input.weekIndex);
  const shownHash = parseContentsHash(input.contentsHash);
  if (!Number.isSafeInteger(input.nowMs)) throw new RangeError("nowMs must be a safe integer");
  const backend = input.backend ?? SANDBOX_PURCHASE_BACKEND;
  if (backend.name !== TUNABLES.PURCHASE_BACKEND) {
    throw new Error(`purchase backend '${backend.name}' is not the registry's PURCHASE_BACKEND '${TUNABLES.PURCHASE_BACKEND}'`);
  }
  const currentWeek = weekIndexAt(input.nowMs);
  if (requestedWeek !== currentWeek) {
    throw conflict("offer_not_current", `the offer previewed was for week ${requestedWeek}; the current week is ${currentWeek} — re-read the store before buying`);
  }
  const offer = packOfferForWeek(currentWeek, tier);
  const causationId = purchaseCausationId(input.accountId, currentWeek, tier);

  try {
    return await withTransaction(pool, async (client) => {
      await lockAccountForAppend(client, input.accountId);
      const prior = await selectPurchase(client, input.accountId, currentWeek, tier);
      // 2. Already bought (settled): the replay. Nothing below runs.
      if (prior && prior.settled_at !== null) return replayPurchase(client, input.accountId, prior, offer);

      // What this call will grant: a fresh offer, or the unsettled reservation's own record.
      const granting: readonly PackContent[] = prior ? prior.contents : offer.contents;

      // 3. The fingerprint of what the client was shown.
      if (shownHash !== null && shownHash !== offerContentsHash(granting)) {
        throw conflict("offer_changed", `the contents previewed (hash ${shownHash.slice(0, 12)}…) are not what this purchase would grant now (hash ${offerContentsHash(granting).slice(0, 12)}…) — re-read the store before buying`);
      }

      // 4a. RESERVE. The UNIQUE (account, week, tier) is the idempotency guard on our side.
      const coinRequested = coinOf(granting);
      const reservation =
        prior ??
        normalizePurchaseRow(
          (
            await client.query<PurchaseRow>(
              `INSERT INTO pack_purchase (account_id, week_index, tier, backend, sandbox_receipt, price_cents, contents,
                                          coin_requested, coin_credited, coin_discarded, causation_id)
               VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb, $7, 0, 0, $8) RETURNING *`,
              [input.accountId, currentWeek, tier, backend.name, offer.priceCents, JSON.stringify(granting), coinRequested, causationId],
            )
          ).rows[0]!,
        );

      // 4b. CHARGE, keyed by the causation id (sandbox: moves no money; see store/sandbox.ts).
      const receipt = backend.charge({ accountId: input.accountId, offer, idempotencyKey: reservation.causation_id });

      // 5. Flush the pending trickle so the credit clamps against the balance the player saw.
      const flushed = await accrueTrickleTx(client, input.accountId, input.nowMs, { force: true });

      // 4c/6. CREDIT, through the economy's one batch-clamped credit path.
      const cosmeticIds = cosmeticIdsOf(granting);
      const credit: CoinCreditResult = await appendCoinCredits(client, {
        causationId: reservation.causation_id,
        accountId: input.accountId,
        credits: [
          {
            type: "coin_purchased",
            amount: coinRequested,
            reason: PURCHASE_REASON,
            extra: {
              tier,
              weekIndex: currentWeek,
              priceCents: reservation.price_cents,
              backend: receipt.backend,
              chargedCents: receipt.chargedCents,
              // The ids OFFERED (N3): rebuild rule is "first event naming an id owns it".
              cosmetics: cosmeticIds,
            },
          },
        ],
      });

      // 4d. SETTLE the reservation — the one update the row's guard admits.
      const settled = normalizePurchaseRow(
        (
          await client.query<PurchaseRow>(
            `UPDATE pack_purchase SET sandbox_receipt = $2, coin_credited = $3, coin_discarded = $4, settled_at = now()
             WHERE id = $1 AND settled_at IS NULL RETURNING *`,
            [reservation.id, receipt.receipt, credit.credited, credit.discarded],
          )
        ).rows[0]!,
      );

      // 7. Cosmetics: account-level ownership, each naming this purchase.
      const granted: string[] = [];
      const alreadyOwned: string[] = [];
      for (const id of cosmeticIds) {
        const kind = getCosmeticType(id)?.kind;
        if (!kind) throw new Error(`offer named unknown cosmetic ${id}`);
        const res = await client.query(
          `INSERT INTO cosmetic_ownership (account_id, cosmetic_id, kind, purchase_id)
           VALUES ($1, $2, $3, $4) ON CONFLICT (account_id, cosmetic_id) DO NOTHING`,
          [input.accountId, id, kind, settled.id],
        );
        if ((res.rowCount ?? 0) === 1) granted.push(id);
        else alreadyOwned.push(id);
      }

      return {
        replayed: false,
        resumed: prior !== null,
        purchase: purchaseView(settled),
        offer,
        coin: { requested: coinRequested, credited: credit.credited, discarded: credit.discarded, balanceAfter: credit.balanceAfter, cap: credit.cap },
        trickle: {
          credited: flushed.materialized ? flushed.credited : 0,
          discarded: flushed.materialized ? flushed.discarded : 0,
          materialized: flushed.materialized,
          accruedFromMs: flushed.accruedFromMs,
          accruedThroughMs: flushed.accruedThroughMs,
          balanceBeforeCredit: flushed.ledgerBalance,
        },
        cosmeticsGranted: granted,
        cosmeticsAlreadyOwned: alreadyOwned,
        events: credit.rows,
      };
    });
  } catch (err) {
    // The UNIQUE backstop: a racing purchase of the same tier in the same week. Nothing of
    // the losing transaction committed (Coin included); the winner's stored outcome is the answer.
    if (isUniqueViolation(err)) {
      const existing = await selectPurchase(pool, input.accountId, currentWeek, tier);
      if (existing && existing.settled_at !== null) return replayPurchase(pool, input.accountId, existing, offer);
    }
    throw err;
  }
}

/** A repeat of a settled purchase: the stored view and stored event, nothing moved (QA-20 D1). */
async function replayPurchase(db: Queryable, accountId: string, row: PurchaseRow, offer: PackOffer): Promise<PurchasePackResult> {
  const events = (await listEventsByCausation(db, row.causation_id)).filter((e) => e.account_id === accountId && e.event_type === "coin_purchased");
  const ownedHere = await db.query<{ cosmetic_id: string }>("SELECT cosmetic_id FROM cosmetic_ownership WHERE account_id = $1 AND purchase_id = $2", [accountId, row.id]);
  const grantedSet = new Set(ownedHere.rows.map((r) => r.cosmetic_id));
  const offered = cosmeticIdsOf(row.contents);
  const { balance, cap } = await readCoinBalance(db, accountId);
  return {
    replayed: true,
    resumed: false,
    purchase: purchaseView(row),
    offer,
    coin: { requested: row.coin_requested, credited: row.coin_credited, discarded: row.coin_discarded, balanceAfter: balance, cap },
    trickle: null,
    cosmeticsGranted: offered.filter((id) => grantedSet.has(id)),
    cosmeticsAlreadyOwned: offered.filter((id) => !grantedSet.has(id)),
    events,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
