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
 */
import { TUNABLES, type PackOffer } from "@caravan/content";
import { randomUUID } from "node:crypto";

export const SANDBOX_BACKEND_NAME = "sandbox_stub" as const;

export interface ChargeRequest {
  accountId: string;
  offer: PackOffer;
}

export interface ChargeReceipt {
  backend: typeof SANDBOX_BACKEND_NAME;
  /** `sandbox:<uuid>` — never a real processor's id. */
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
    // The receipt is an opaque id for the record; it carries no entropy that matters.
    return { backend: SANDBOX_BACKEND_NAME, receipt: `sandbox:${randomUUID()}`, chargedCents: 0 };
  },
});
