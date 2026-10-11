import type { FastifyInstance } from "fastify";
import { listEventsPageForAccount } from "../ledger/ledger.js";
import { requireAuth } from "./require-auth.js";

/** Validated at the edge (QA-02 S8): a malformed cursor or page size is a 400, never a 500. */
const querySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
  },
} as const;

/** The player's own ledger, oldest first, cursor on seq. The provably-fair record. */
export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { after: number; limit: number } }>(
    "/me/ledger",
    { preHandler: requireAuth, schema: { querystring: querySchema } },
    async (req) => {
      const account = req.auth!.account;
      const { after, limit } = req.query;
      const { events, hasMore } = await listEventsPageForAccount(app.db, account.id, { afterSeq: after, limit });
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
        nextAfter: events.at(-1)?.seq ?? after,
        hasMore,
      };
    },
  );
}
