/**
 * Store routes (chunk 20). The storefront is the legibility contract: every tier's exact
 * price, exact Coin, exact cosmetics and the overflow forecast — before any purchase. The
 * purchase names the week it previewed; the server re-derives the offer. SANDBOX: no
 * money moves (src/store/sandbox.ts). The wall clock enters here, once, as `Date.now()`.
 */
import type { FastifyInstance } from "fastify";
import { listPurchases, purchasePack, purchaseView, storeView } from "../store/index.js";
import { badRequest } from "../services/errors.js";
import { requireAuth } from "./require-auth.js";

export async function storeRoutes(app: FastifyInstance): Promise<void> {
  /** This week's three tiers with purchase state and forecasts, plus next week's rotation. */
  app.get("/me/store", { preHandler: requireAuth }, async (req) => storeView(app.db, req.auth!.account.id, Date.now()));

  /**
   * Buy one tier of the current week. Body `{ tier, weekIndex, contentsHash }` — `contentsHash`
   * is REQUIRED here: the offer's `contentsHash` from GET /me/store, so the server can refuse
   * (409 `offer_changed`) a purchase whose grant is no longer what was shown (QA-20 S2).
   * 201 with the grant; 200 `{ replayed: true }` with the stored purchase and event if this
   * tier was already bought this week (QA-20 D1); 409 `offer_not_current` if the week rolled over.
   */
  app.post<{ Body: { tier?: unknown; weekIndex?: unknown; contentsHash?: unknown } }>("/me/store/purchase", { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    if (body.contentsHash === undefined) {
      throw badRequest("contents_hash_required", "send the offer's contentsHash from GET /me/store with the purchase");
    }
    const result = await purchasePack(app.db, {
      accountId: req.auth!.account.id,
      tier: body.tier,
      weekIndex: body.weekIndex,
      contentsHash: body.contentsHash,
      nowMs: Date.now(),
    });
    reply.code(result.replayed ? 200 : 201);
    return {
      sandbox: true,
      /** True => this tier was already bought this week; the stored outcome is returned and nothing moved. */
      replayed: result.replayed,
      purchase: result.purchase,
      coin: result.coin,
      trickle: result.trickle,
      cosmeticsGranted: result.cosmeticsGranted,
      cosmeticsAlreadyOwned: result.cosmeticsAlreadyOwned,
      events: result.events.map((e) => ({ seq: e.seq, type: e.event_type, payload: e.payload })),
    };
  });

  /** Every purchase this account ever made, oldest first. */
  app.get("/me/store/purchases", { preHandler: requireAuth }, async (req) => ({
    purchases: (await listPurchases(app.db, req.auth!.account.id)).map(purchaseView),
  }));
}
