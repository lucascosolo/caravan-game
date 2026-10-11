/**
 * Standing raid party routes (chunk 09). All account-scoped: the caller's own party only.
 *
 *   GET /me/party        the builder view: config, validity + issues, the resolved party,
 *                        the scouting PREVIEW (exactly what a defender is served), the
 *                        roster to draw from, the siege counter table, caps and rules
 *   PUT /me/party        replace the party. Free, instant, no cooldown. 400 with the full
 *                        issue list if it cannot stand (caps, stance, edge, band, duplicates,
 *                        a ref no longer in the roster, a locked type)
 *   GET /me/party/feed   where the party was served, outcome, depth, Coin and Reputation
 *
 * There is deliberately no route that serves another account's party (chunk 14 does that,
 * from a snapshot, to the defender it was matched against), none that consumes or damages a
 * party (no such code exists), and no Coin path: nothing about a party is purchasable.
 */
import type { FastifyInstance } from "fastify";
import { withTransaction } from "../db/pool.js";
import { listPartyFeed } from "../party/feed.js";
import { PartyValidationError, readParty, saveParty } from "../party/service.js";
import { requireAuth } from "./require-auth.js";

const feedQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    before: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
} as const;

export async function partyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/party", { preHandler: requireAuth }, async (req) => {
    return { party: await readParty(app.db, req.auth!.account.id) };
  });

  app.put("/me/party", { preHandler: requireAuth }, async (req) => {
    const accountId = req.auth!.account.id;
    const party = await withTransaction(app.db, (client) => saveParty(client, accountId, req.body));
    return { party };
  });

  app.get<{ Querystring: { before: number; limit: number } }>(
    "/me/party/feed",
    { preHandler: requireAuth, schema: { querystring: feedQuerySchema } },
    async (req) => {
      const { before, limit } = req.query;
      return listPartyFeed(app.db, req.auth!.account.id, { before, limit });
    },
  );

  // Validation failures carry their issue list so the builder can show every problem at once.
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof PartyValidationError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, issues: err.issues });
    }
    throw err;
  });
}
