/**
 * Store routes (chunk 20). The storefront is the legibility contract: every tier's exact
 * price, exact Coin, exact cosmetics and the overflow forecast — before any purchase. The
 * purchase names the week it previewed; the server re-derives the offer. SANDBOX: no
 * money moves (src/store/sandbox.ts). The wall clock enters here, once, as `Date.now()`.
 */
import type { FastifyInstance } from "fastify";
import { listPurchases, purchasePack, purchaseView, storeView } from "../store/index.js";
import { requireAuth } from "./require-auth.js";

export async function storeRoutes(app: FastifyInstance): Promise<void> {
  /** This week's three tiers with purchase state and forecasts, plus next week's rotation. */
  app.get("/me/store", { preHandler: requireAuth }, async (req) => storeView(app.db, req.auth!.account.id, Date.now()));

  /** Buy one tier of the current week. 201 with the grant; 409 if that tier was already bought this week or the week rolled over. */
  app.post<{ Body: { tier?: unknown; weekIndex?: unknown } }>("/me/store/purchase", { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const result = await purchasePack(app.db, { accountId: req.auth!.account.id, tier: body.tier, weekIndex: body.weekIndex, nowMs: Date.now() });
    reply.code(201);
    return {
      sandbox: true,
      purchase: result.purchase,
      coin: result.coin,
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
