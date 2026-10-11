/**
 * Buying a pack (chunk 20). One transaction, under the account's ledger append lock:
 *
 *   1. the offer is re-derived SERVER-SIDE from (current week, tier) — the client names the
 *      week it previewed and is refused (`offer_not_current`) if that week has rolled
 *      over, so what was shown is exactly what is granted (GUARDRAILS §4);
 *   2. the per-tier-per-week limit: a prior row for (account, week, tier) → 409
 *      `tier_already_purchased_this_week`; the UNIQUE constraint is the backstop under a
 *      race (23505 → the same 409), and the advisory lock serializes honest callers so
 *      the second one sees the first's row rather than hitting the constraint;
 *   3. the SANDBOX backend "charges" — records a receipt, moves no money (store/sandbox.ts);
 *   4. the Coin lands through chunk 16's `appendCoinCredits` as a `coin_purchased` event:
 *      clamped to the storage cap like every other credit, with `overflowDiscarded`
 *      recorded on the event and on the purchase row — the cap cannot be raced because the
 *      room is read under the same lock the credit is written under;
 *   5. cosmetics become account-level ownership rows (ON CONFLICT DO NOTHING: a cosmetic
 *      that rotates back is not granted twice; the response says which were already owned).
 *
 * Nothing here reads anything but Coin and the account's own purchase rows; nothing here
 * writes to any caravan, roster, unlock, ladder or trip table — a source scan asserts it.
 */
import { TUNABLES, getCosmeticType, isPackTier, packOfferForWeek, weekIndexAt, type PackOffer, type PackTier } from "@caravan/content";
import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import { appendCoinCredits, type CoinCreditResult } from "../economy/coin.js";
import type { LedgerEventRow } from "../ledger/events.js";
import { lockAccountForAppend } from "../ledger/ledger.js";
import { badRequest, conflict, type AppError } from "../services/errors.js";
import { normalizePurchaseRow, purchaseView, type PurchaseRow } from "./offers.js";
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
  nowMs: number;
  backend?: PurchaseBackend;
}

export interface PurchasePackResult {
  purchase: ReturnType<typeof purchaseView>;
  offer: PackOffer;
  coin: { requested: number; credited: number; discarded: number; balanceAfter: number; cap: number };
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

export async function purchasePack(pool: pg.Pool, input: PurchasePackInput): Promise<PurchasePackResult> {
  const tier = parseTier(input.tier);
  const requestedWeek = parseWeek(input.weekIndex);
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
      const prior = await client.query<PurchaseRow>("SELECT * FROM pack_purchase WHERE account_id = $1 AND week_index = $2 AND tier = $3", [
        input.accountId,
        currentWeek,
        tier,
      ]);
      if (prior.rows[0]) throw alreadyPurchased(prior.rows[0]);

      // 3. The sandbox "charge". Moves no money; see store/sandbox.ts.
      const receipt = backend.charge({ accountId: input.accountId, offer });

      // 4. The Coin, through the economy's one batch-clamped credit path.
      const credit: CoinCreditResult = await appendCoinCredits(client, {
        causationId,
        accountId: input.accountId,
        credits: [
          {
            type: "coin_purchased",
            amount: offer.coin,
            reason: PURCHASE_REASON,
            extra: {
              tier,
              weekIndex: currentWeek,
              priceCents: offer.priceCents,
              backend: receipt.backend,
              chargedCents: receipt.chargedCents,
              cosmetics: offer.cosmetics.map((c) => c.id),
            },
          },
        ],
      });

      const inserted = await client.query<PurchaseRow>(
        `INSERT INTO pack_purchase (account_id, week_index, tier, backend, sandbox_receipt, price_cents, contents,
                                    coin_requested, coin_credited, coin_discarded, causation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) RETURNING *`,
        [
          input.accountId,
          currentWeek,
          tier,
          receipt.backend,
          receipt.receipt,
          offer.priceCents,
          JSON.stringify(offer.contents),
          offer.coin,
          credit.credited,
          credit.discarded,
          causationId,
        ],
      );
      const row = normalizePurchaseRow(inserted.rows[0]!);

      // 5. Cosmetics: account-level ownership, each naming this purchase.
      const granted: string[] = [];
      const alreadyOwned: string[] = [];
      for (const c of offer.cosmetics) {
        const kind = getCosmeticType(c.id)?.kind;
        if (!kind) throw new Error(`offer named unknown cosmetic ${c.id}`);
        const res = await client.query(
          `INSERT INTO cosmetic_ownership (account_id, cosmetic_id, kind, purchase_id)
           VALUES ($1, $2, $3, $4) ON CONFLICT (account_id, cosmetic_id) DO NOTHING`,
          [input.accountId, c.id, kind, row.id],
        );
        if ((res.rowCount ?? 0) === 1) granted.push(c.id);
        else alreadyOwned.push(c.id);
      }

      return {
        purchase: purchaseView(row),
        offer,
        coin: { requested: offer.coin, credited: credit.credited, discarded: credit.discarded, balanceAfter: credit.balanceAfter, cap: credit.cap },
        cosmeticsGranted: granted,
        cosmeticsAlreadyOwned: alreadyOwned,
        events: credit.rows,
      };
    });
  } catch (err) {
    // The UNIQUE backstop: a racing purchase of the same tier in the same week. Nothing of
    // the losing transaction committed (Coin included).
    if (isUniqueViolation(err)) {
      const existing = await pool.query<PurchaseRow>("SELECT * FROM pack_purchase WHERE account_id = $1 AND week_index = $2 AND tier = $3", [
        input.accountId,
        currentWeek,
        tier,
      ]);
      if (existing.rows[0]) throw alreadyPurchased(existing.rows[0]);
    }
    throw err;
  }
}

function alreadyPurchased(row: PurchaseRow): AppError {
  const r = normalizePurchaseRow(row);
  return conflict(
    "tier_already_purchased_this_week",
    `tier ${r.tier} was already bought in week ${r.week_index} (purchase ${r.id}, ${r.purchased_at.toISOString()}); each tier is purchasable once per week`,
  );
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
