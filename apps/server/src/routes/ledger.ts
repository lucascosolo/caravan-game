import type { FastifyInstance } from "fastify";
import { listEventsForAccount } from "../ledger/ledger.js";
import { requireAuth } from "./require-auth.js";

/** The player's own ledger, oldest first, cursor on seq. The provably-fair record. */
export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { after?: string; limit?: string } }>("/me/ledger", { preHandler: requireAuth }, async (req) => {
    const account = req.auth!.account;
    const afterSeq = Number(req.query.after ?? 0);
    const limit = Number(req.query.limit ?? 100);
    const opts: { afterSeq?: number; limit?: number } = {};
    if (Number.isFinite(afterSeq) && afterSeq >= 0) opts.afterSeq = afterSeq;
    if (Number.isFinite(limit) && limit > 0) opts.limit = limit;
    const events = await listEventsForAccount(app.db, account.id, opts);
    return {
      events: events.map((e) => ({
        seq: e.seq,
        type: e.event_type,
        accountId: e.account_id,
        caravanId: e.caravan_id,
        causationId: e.causation_id,
        causationSeq: e.causation_seq,
        resolverVersion: e.resolver_version,
        payload: e.payload,
        occurredAt: e.occurred_at.toISOString(),
      })),
      nextAfter: events.at(-1)?.seq ?? opts.afterSeq ?? 0,
    };
  });
}
