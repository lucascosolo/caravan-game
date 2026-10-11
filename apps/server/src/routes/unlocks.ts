/**
 * Unlock web routes (chunk 05).
 *
 *   GET  /unlocks/webs        public: every web, every node, every cost — the same for everyone
 *   GET  /me/unlocks          the caller's webs with reached / affordable state and points
 *   POST /me/unlocks/spend    { pool, nodeId, caravanId? } — reach a node with granted points
 *
 * There is no route that grants points (chunk 04's rung crossings are the only source), no
 * refund, and no route that creates an instance: reaching a node is access, nothing more.
 */
import type { FastifyInstance } from "fastify";
import { withTransaction } from "../db/pool.js";
import { parseSpendRequest, publicUnlockWebs, spendUnlockPoints, unlockWebsSnapshot } from "../unlocks/index.js";
import { requireAuth } from "./require-auth.js";

export async function unlockRoutes(app: FastifyInstance): Promise<void> {
  app.get("/unlocks/webs", async () => publicUnlockWebs());

  app.get("/me/unlocks", { preHandler: requireAuth }, async (req) => {
    // One read-only snapshot (QA-05 N1): points and purchases from the same committed state.
    return { webs: await unlockWebsSnapshot(app.db, req.auth!.account.id) };
  });

  app.post("/me/unlocks/spend", { preHandler: requireAuth }, async (req, reply) => {
    const accountId = req.auth!.account.id;
    const spend = parseSpendRequest(req.body);
    const result = await withTransaction(app.db, (client) => spendUnlockPoints(client, accountId, spend));
    return reply.code(result.created ? 201 : 200).send(result);
  });
}
