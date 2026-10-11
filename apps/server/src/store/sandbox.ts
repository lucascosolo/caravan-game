/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════╗
 * ║  SANDBOX PURCHASE BACKEND — A STUB. NO MONEY MOVES. NOTHING IS CHARGED. (chunk 20)    ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════╝
 *
 * The MVP "payment processor": it accepts every purchase, issues a receipt string that
 * says SANDBOX in it, and charges nothing. It exists so the GUARDRAIL side of the store
 * (fixed contents, previews, the cap clamp, the once-per-tier-per-week limit, the
 * resolver boundary) can be built and tested for real while billing is not.
 *
 * Real payment integration is PHASE-2 §34 and is deliberately NOT started here. When it
 * is, it replaces this module behind the same `PurchaseBackend` interface, the registry's
 * PURCHASE_BACKEND changes, and migration 010's `backend = 'sandbox_stub'` CHECK is
 * widened in a migration a reviewer will see. `purchasePack` refuses to run under any
 * backend name but the one the registry names.
 *
 * THE CHARGE-ORDERING RULE (QA-20 D2) — binding on any real backend that replaces this one:
 *
 *   1. RESERVE. Insert the `pack_purchase` row first, as a reservation (no receipt, nothing
 *      credited). Its UNIQUE (account, week, tier) is the idempotency guard on OUR side: a
 *      second attempt at the same tier this week finds the row instead of creating a charge.
 *   2. CHARGE. Call the backend with `idempotencyKey` = the purchase's `causationId`
 *      (`pack:<account>:w<week>:t<tier>`). The backend must treat a repeated key as the same
 *      charge (return the original result, never charge twice) — so a retry after a crash
 *      between 2 and 3 converges on one charge, not two.
 *   3. CREDIT + SETTLE. Credit the Coin through `appendCoinCredits` (`coin_purchased`, same
 *      causation id — the ledger's own causation uniqueness is the guard there), then settle
 *      the reservation in place with the receipt and the credited/discarded split.
 *
 * Never charge before the reservation exists (a charge with nothing to attach it to is
 * money taken for nothing), and never credit before the charge returns. A reservation found
 * unsettled on a later attempt is RESUMED from step 2 with the same key (purchase.ts). With
 * this stub the three steps run in one transaction, so an unsettled reservation can only be
 * seen by a test that writes one by hand; a real backend's charge is a network call and must
 * run outside the database transaction (reserve → commit → charge → credit+settle), which is
 * exactly why the order and the key are fixed now.
 */
import { TUNABLES, type PackOffer } from "@caravan/content";
import { createHash } from "node:crypto";

export const SANDBOX_BACKEND_NAME = "sandbox_stub" as const;

export interface ChargeRequest {
  accountId: string;
  offer: PackOffer;
  /** The purchase's causation id. The same key must always mean the same single charge. */
  idempotencyKey: string;
}

export interface ChargeReceipt {
  backend: typeof SANDBOX_BACKEND_NAME;
  /** `sandbox:<uuid-shaped digest of the idempotency key>` — never a real processor's id. Same key, same receipt. */
  receipt: string;
  /** Always 0 for the sandbox: the price was recorded, not collected. */
  chargedCents: 0;
}

export interface PurchaseBackend {
  readonly name: typeof SANDBOX_BACKEND_NAME;
  charge(req: ChargeRequest): ChargeReceipt;
}

/** The one and only backend in this build. Loud by name, by receipt prefix and by `chargedCents: 0`. */
export const SANDBOX_PURCHASE_BACKEND: PurchaseBackend = Object.freeze({
  name: SANDBOX_BACKEND_NAME,
  charge(req: ChargeRequest): ChargeReceipt {
    if (TUNABLES.PURCHASE_BACKEND !== SANDBOX_BACKEND_NAME) {
      throw new Error(`PURCHASE_BACKEND is '${TUNABLES.PURCHASE_BACKEND}' but only the sandbox stub exists in this build`);
    }
    if (!req.accountId || !req.offer) throw new TypeError("sandbox charge needs an account and an offer");
    if (typeof req.idempotencyKey !== "string" || req.idempotencyKey.length === 0) throw new TypeError("sandbox charge needs an idempotency key (the purchase causation id)");
    // Idempotent like a real processor must be: the receipt is a pure function of the key,
    // so a resumed charge returns the very receipt the first attempt would have.
    const h = createHash("sha256").update(`sandbox-charge:${req.idempotencyKey}`).digest("hex");
    const uuidShaped = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    return { backend: SANDBOX_BACKEND_NAME, receipt: `sandbox:${uuidShaped}`, chargedCents: 0 };
  },
});
