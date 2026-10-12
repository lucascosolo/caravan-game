/**
 * Matchmaking & scouting routes (chunk 14). Caravan-scoped and owner-only: another
 * account's caravan is a 404, never a hint that it exists. The player is the DEFENDER;
 * these routes pick and scout who will attack them.
 *
 *   POST /me/caravans/:caravanId/encounters/:n/search      draw 3 candidates (free; a repeat is time-gated)
 *   GET  /me/caravans/:caravanId/encounters/:n/candidates  the current menu, every candidate scoutable in full;
 *                                                          200 `{ menu: null, searched: false }` before the first search (N10)
 *   POST /me/caravans/:caravanId/encounters/:n/choose      commit to one ({ candidateId })
 *
 * There is deliberately no route that shortens the reroll wait, no body field that could
 * carry a payment, and nothing here reads Coin, purchases or entitlements (GUARDRAILS §2).
 * Trip start/end and resolution are chunk 15's.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTransaction } from "../db/pool.js";
import type { CaravanRow } from "../db/types.js";
import { RerollCooldownError, chooseCandidate, notFound, readCandidatesOrEmpty, searchCandidates } from "../matchmaking/service.js";
import { findCaravanById } from "../repo/caravans.js";
import { badRequest } from "../services/errors.js";
import { isUuid } from "../util/uuid.js";
import { requireAuth } from "./require-auth.js";

type EncounterParams = { caravanId: string; n: string };

async function ownCaravan(req: FastifyRequest<{ Params: EncounterParams }>): Promise<CaravanRow> {
  const caravan = isUuid(req.params.caravanId) ? await findCaravanById(req.server.db, req.params.caravanId) : null;
  if (!caravan || caravan.account_id !== req.auth!.account.id) throw notFound("no_caravan", "caravan not found");
  return caravan;
}

/** A positive integer with no leading zero, at most six digits (chunk 07 QA N2). */
function encounterIndex(raw: string): number {
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw badRequest("bad_encounter", "encounter index must be a positive integer");
  return Number(raw);
}

function parseChoice(body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw badRequest("bad_body", "expected a JSON object");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== "candidateId") throw badRequest("bad_body", `unknown key '${k}'`);
  if (typeof b["candidateId"] !== "string") throw badRequest("bad_body", "candidateId must be a string");
  return b["candidateId"];
}

export async function matchmakingRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: EncounterParams }>("/me/caravans/:caravanId/encounters/:n/search", { preHandler: requireAuth }, async (req, reply) => {
    const caravan = await ownCaravan(req);
    const n = encounterIndex(req.params.n);
    const nowMs = Date.now();
    const menu = await withTransaction(app.db, (client) => searchCandidates(client, caravan, n, { nowMs }));
    return reply.code(201).send({ menu });
  });

  app.get<{ Params: EncounterParams }>("/me/caravans/:caravanId/encounters/:n/candidates", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    return readCandidatesOrEmpty(app.db, caravan, encounterIndex(req.params.n), Date.now());
  });

  app.post<{ Params: EncounterParams }>("/me/caravans/:caravanId/encounters/:n/choose", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    const n = encounterIndex(req.params.n);
    const candidateId = parseChoice(req.body);
    return withTransaction(app.db, (client) => chooseCandidate(client, caravan, n, candidateId, Date.now()));
  });

  // The reroll gate says exactly when the next free search opens; nothing else is attached.
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof RerollCooldownError) {
      return reply
        .code(err.statusCode)
        .header("retry-after", String(err.retryAfterSeconds))
        .send({ error: err.code, message: err.message, availableAtMs: err.availableAtMs, retryAfterSeconds: err.retryAfterSeconds, gate: "time" });
    }
    throw err;
  });
}
