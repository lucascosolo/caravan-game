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

/**
 * Chunk 19 QA S1 (chunk 14 QA N4: account ids are not public): the read model drops every
 * payload key naming an account (`…AccountId`, `accountId`) whose value is not the reader's
 * own id, at any depth — `trip_overrun.partyOwnerAccountId`, `encounter_resolved`'s
 * `partyOwnerAccountId` and its snapshot's `ownerAccountId`, `party_served_as_encounter`'s
 * `defenderAccountId`. The ledger row itself is untouched (it is the auditable record); this
 * filters what leaves through the route only.
 */
const ACCOUNT_KEY = /(^a|A)ccountId$/;
/**
 * Final review N4: a caravan id is a stable per-player key too (one caravan per account in v1), so
 * every `…CaravanId` / `caravanId` key whose value is not one of the reader's own caravans is
 * dropped the same way — `party_served_as_encounter.defenderCaravanId` is the one that reached a
 * party owner. (The account export already replaces them with "other_player".)
 */
const CARAVAN_KEY = /(^c|C)aravanId$/;
export function redactForeignIds(value: unknown, ownAccountId: string, ownCaravanIds: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => redactForeignIds(v, ownAccountId, ownCaravanIds));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ACCOUNT_KEY.test(k) && v !== ownAccountId) continue;
    if (CARAVAN_KEY.test(k) && !(typeof v === "string" && ownCaravanIds.has(v))) continue;
    out[k] = redactForeignIds(v, ownAccountId, ownCaravanIds);
  }
  return out;
}

/** Account ids only (chunk 19 QA S1); kept for callers with no caravan context. */
export function redactForeignAccountIds(value: unknown, ownAccountId: string): unknown {
  if (Array.isArray(value)) return value.map((v) => redactForeignAccountIds(v, ownAccountId));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ACCOUNT_KEY.test(k) && v !== ownAccountId) continue;
    out[k] = redactForeignAccountIds(v, ownAccountId);
  }
  return out;
}

/** The player's own ledger, oldest first, cursor on seq. The provably-fair record. */
export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { after: number; limit: number } }>(
    "/me/ledger",
    { preHandler: requireAuth, schema: { querystring: querySchema } },
    async (req) => {
      const account = req.auth!.account;
      const { after, limit } = req.query;
      const { events, hasMore } = await listEventsPageForAccount(app.db, account.id, { afterSeq: after, limit });
      const own = new Set((await app.db.query<{ id: string }>("SELECT id FROM caravan WHERE account_id = $1", [account.id])).rows.map((r) => r.id));
      return {
        events: events.map((e) => ({
          seq: e.seq,
          type: e.event_type,
          accountId: e.account_id,
          caravanId: e.caravan_id,
          causationId: e.causation_id,
          causationSeq: e.causation_seq,
          resolverVersion: e.resolver_version,
          payload: redactForeignIds(e.payload, account.id, own),
          occurredAt: e.occurred_at.toISOString(),
        })),
        nextAfter: events.at(-1)?.seq ?? after,
        hasMore,
      };
    },
  );
}
