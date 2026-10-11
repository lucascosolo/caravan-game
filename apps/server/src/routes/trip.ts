/**
 * Trip loop routes (chunk 15). Caravan-scoped and owner-only: another account's caravan is
 * a 404. The player is the DEFENDER escorting the caravan; nothing here attacks anyone.
 *
 *   GET  /me/caravans/:caravanId/trip                         status, phase, trip cap (settles a finished resolution)
 *   POST /me/caravans/:caravanId/trip/start                   ride out with the packed manifest (one trip-cap use)
 *   POST /me/caravans/:caravanId/trip/encounters/:n/commit    freeze the arranged circle; queue its resolution
 *   GET  /me/caravans/:caravanId/trip/preview                 the bank-or-push stakes, itemized
 *   POST /me/caravans/:caravanId/trip/push   { tripId, encounterIndex }
 *   POST /me/caravans/:caravanId/trip/bank   { tripId, encounterIndex }
 *
 * Search / candidates / choose are chunk 14's routes (/me/caravans/:id/encounters/:n/…) and
 * arranging is chunk 07's (PUT /caravans/:id/encounters/:n/formation). There is no route that
 * edits a manifest, repairs, heals, restocks, refunds a trip-cap use or abandons a trip
 * mid-encounter, and nothing here reads Coin balances except the bank preview's forecast.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { commitFormation } from "../circle/service.js";
import { withTransaction } from "../db/pool.js";
import type { CaravanRow } from "../db/types.js";
import { findCaravanById } from "../repo/caravans.js";
import { AppError, badRequest } from "../services/errors.js";
import { TripCapExhaustedError } from "../trip/cap.js";
import { bankTrip, commitEncounter, encounterResolverAvailable, parseDecision, pushTrip, settleEncounter, stakesPreview, startTrip, tripStatus } from "../trip/service.js";
import { isUuid } from "../util/uuid.js";
import { requireAuth } from "./require-auth.js";

type CaravanParams = { caravanId: string };
type EncounterParams = { caravanId: string; n: string };

async function ownCaravan(req: FastifyRequest<{ Params: CaravanParams }>): Promise<CaravanRow> {
  const caravan = isUuid(req.params.caravanId) ? await findCaravanById(req.server.db, req.params.caravanId) : null;
  if (!caravan || caravan.account_id !== req.auth!.account.id) throw new AppError(404, "no_caravan", "caravan not found");
  return caravan;
}

function encounterIndex(raw: string): number {
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw badRequest("bad_encounter", "encounter index must be a positive integer");
  return Number(raw);
}

export async function tripRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: CaravanParams }>("/me/caravans/:caravanId/trip", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    return tripStatus(app.db, caravan, Date.now());
  });

  app.post<{ Params: CaravanParams }>("/me/caravans/:caravanId/trip/start", { preHandler: requireAuth }, async (req, reply) => {
    const caravan = await ownCaravan(req);
    const nowMs = Date.now();
    // Chunk 15 QA D3: refused 409 resolver_unavailable only when no resolver can ever take the
    // encounter (production handler unwired and no CARAVAN_TEST_RESOLVER double installed).
    const resolverAvailable = encounterResolverAvailable(app.inlineEncounterWorker !== null);
    const started = await withTransaction(app.db, (client) => startTrip(client, caravan, nowMs, { resolverAvailable }));
    return reply.code(201).send({ tripId: started.trip.id, manifestId: started.trip.manifest_id, cap: started.cap.after, status: await tripStatus(app.db, caravan, nowMs) });
  });

  app.post<{ Params: EncounterParams }>("/me/caravans/:caravanId/trip/encounters/:n/commit", { preHandler: requireAuth }, async (req, reply) => {
    const caravan = await ownCaravan(req);
    const n = encounterIndex(req.params.n);
    const { job, created } = await withTransaction(app.db, (client) => commitEncounter(client, caravan, n, commitFormation));
    // QA-13 S1: the in-process worker resolves it shortly after this answer (the real resolver; the double under
    // CARAVAN_TEST_RESOLVER) and settles in its completion transaction / voids a trip whose job parks (TRIP_SETTLE_HOOKS).
    app.encounterWorker?.kick();
    return reply.code(created ? 202 : 200).send({ jobId: job.id, jobStatus: job.status, created });
  });

  app.get<{ Params: CaravanParams }>("/me/caravans/:caravanId/trip/preview", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    return stakesPreview(app.db, caravan, Date.now());
  });

  app.post<{ Params: CaravanParams }>("/me/caravans/:caravanId/trip/push", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    const decision = parseDecision(req.body);
    await settleEncounter(app.db, caravan);
    return withTransaction(app.db, (client) => pushTrip(client, caravan, decision));
  });

  app.post<{ Params: CaravanParams }>("/me/caravans/:caravanId/trip/bank", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    const decision = parseDecision(req.body);
    await settleEncounter(app.db, caravan);
    return withTransaction(app.db, (client) => bankTrip(client, caravan, decision));
  });

  // The trip cap says exactly when the next start opens; it is time-gated only.
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof TripCapExhaustedError) {
      return reply
        .code(err.statusCode)
        .header("retry-after", String(err.retryAfterSeconds))
        .send({ error: err.code, message: err.message, cap: err.cap, retryAfterSeconds: err.retryAfterSeconds });
    }
    throw err;
  });
}
