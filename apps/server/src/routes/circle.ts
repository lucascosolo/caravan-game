/**
 * Wagon circle routes (chunk 07). All caravan-scoped and owner-only: a caravan that is not
 * the caller's is a 404, never a hint that it exists.
 *
 *   POST /caravans/:caravanId/manifest                               pack & lock (town → trail)
 *   DELETE /caravans/:caravanId/manifest                             unpack a caravan that has not ridden out
 *                                                                     (final play-test review N9: packed with no
 *                                                                     trip available is never a dead end)
 *   GET  /caravans/:caravanId/manifest                               the open manifest + survivors + stakes summary;
 *                                                                     200 `{ manifest: null }` in town with nothing
 *                                                                     packed (final play-test review N10)
 *   PUT  /caravans/:caravanId/encounters/:n/formation                draft / re-draft the next encounter's arrangement
 *   GET  /caravans/:caravanId/encounters/:n/formation                read it (and its gaps)
 *   POST /caravans/:caravanId/encounters/:n/formation/commit         freeze it: only inside an open trip, against
 *                                                                     a CHOSEN (scouted) candidate (chunk 15 QA N4).
 *                                                                     The trip loop's commit route also queues the
 *                                                                     resolution; this one only freezes.
 *
 * There is deliberately no route that edits a manifest or applies an outcome, and the only
 * client-facing close is the unpack of a manifest that never rode out: closing a trip's
 * manifest belongs to the trip loop (chunk 15), outcomes to the resolution path (chunk 13).
 */
import { layoutView, rememberLayout } from "../circle/layout.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTransaction } from "../db/pool.js";
import type { CaravanRow } from "../db/types.js";
import { chosenCandidate } from "../matchmaking/service.js";
import { findOpenTrip } from "../matchmaking/trips.js";
import { findOpenManifest } from "../circle/repo.js";
import { findCaravanById } from "../repo/caravans.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { unpackManifest } from "../trip/service.js";
import {
  CircleValidationError,
  commitFormation,
  getFormation,
  lockManifest,
  manifestView,
  notFound,
  saveFormation,
  type PackRequest,
} from "../circle/service.js";
import { isUuid } from "../util/uuid.js";
import { requireAuth } from "./require-auth.js";

type CaravanParams = { caravanId: string };
type EncounterParams = CaravanParams & { n: string };


async function ownCaravan(req: FastifyRequest<{ Params: CaravanParams }>): Promise<CaravanRow> {
  const caravan = isUuid(req.params.caravanId) ? await findCaravanById(req.server.db, req.params.caravanId) : null;
  if (!caravan || caravan.account_id !== req.auth!.account.id) throw notFound("no_caravan", "caravan not found");
  return caravan;
}

/** QA N2: a positive integer with no leading zero, at most six digits. */
function encounterIndex(raw: string): number {
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw badRequest("bad_encounter", "encounter index must be a positive integer");
  return Number(raw);
}

/**
 * QA S3: the pack body is parsed as strictly as a formation is — an object (never an
 * array), only the known keys at each level, each of the right shape.
 */
function parsePackRequest(body: unknown): PackRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw badRequest("bad_body", "expected a JSON object");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!["units", "traps", "fence"].includes(k)) throw badRequest("bad_body", `unknown key '${k}'`);
  const strings = (v: unknown, name: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0)) throw badRequest("bad_body", `${name} must be an array of ids`);
    return v as string[];
  };
  let fence: PackRequest["fence"] = null;
  if (b["fence"] !== undefined && b["fence"] !== null) {
    const f = b["fence"];
    if (typeof f !== "object" || Array.isArray(f)) throw badRequest("bad_body", "fence must be { tierId, count } or null");
    const fo = f as Record<string, unknown>;
    for (const k of Object.keys(fo)) if (!["tierId", "count"].includes(k)) throw badRequest("bad_body", `unknown key 'fence.${k}'`);
    const { tierId, count } = fo;
    if (typeof tierId !== "string" || typeof count !== "number") throw badRequest("bad_body", "fence must be { tierId: string, count: number }");
    fence = { tierId, count };
  }
  return { units: strings(b["units"], "units"), traps: strings(b["traps"], "traps"), fence };
}

export async function circleRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: CaravanParams }>("/caravans/:caravanId/manifest", { preHandler: requireAuth }, async (req, reply) => {
    const caravan = await ownCaravan(req);
    const pack = parsePackRequest(req.body);
    const row = await withTransaction(app.db, (client) => lockManifest(client, caravan, pack));
    return reply.code(201).send({ manifest: await manifestView(app.db, row) });
  });

  app.delete<{ Params: CaravanParams }>("/caravans/:caravanId/manifest", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    return { unpacked: await withTransaction(app.db, (client) => unpackManifest(client, caravan)) };
  });

  app.get<{ Params: CaravanParams }>("/caravans/:caravanId/manifest", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    // N10: nothing packed is an empty state, not an error.
    const row = await findOpenManifest(app.db, caravan.id);
    return { manifest: row ? await manifestView(app.db, row) : null };
  });

  app.put<{ Params: EncounterParams }>("/caravans/:caravanId/encounters/:n/formation", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    const n = encounterIndex(req.params.n);
    const formation = await withTransaction(app.db, (client) => saveFormation(client, caravan, n, req.body));
    return { formation };
  });

  app.get<{ Params: EncounterParams; Querystring: { ifNone?: string } }>("/caravans/:caravanId/encounters/:n/formation", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    const n = encounterIndex(req.params.n);
    // Final play-test review r2 N10: "no draft yet" is an empty state. A client that asks for it
    // (`?ifNone=null`) gets 200 `{ formation: null, encounterIndex }`; without the parameter the
    // answer stays the 404 `no_formation` that current clients expect (additive, as N10 did for
    // the manifest and the candidates). Final play-test review r3 N10: so is an encounter of a trip
    // that has ended (the manifest is closed, nothing is packed): no draft there either.
    if (req.query.ifNone === "null") {
      try {
        return { formation: await getFormation(app.db, caravan, n), layout: await layoutView(app.db, caravan, n) };
      } catch (err) {
        if (err instanceof AppError && (err.code === "no_formation" || err.code === "no_open_manifest")) return { formation: null, encounterIndex: n, layout: await layoutView(app.db, caravan, n) };
        throw err;
      }
    }
    return { formation: await getFormation(app.db, caravan, n), layout: await layoutView(app.db, caravan, n) };
  });

  app.post<{ Params: EncounterParams }>("/caravans/:caravanId/encounters/:n/formation/commit", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    const n = encounterIndex(req.params.n);
    const formation = await withTransaction(app.db, async (client) => {
      // Chunk 15 QA N4: never freeze a circle outside the trip loop, or before the party it is
      // arranged against was scouted and chosen (GUARDRAILS §4: no blind commit).
      const trip = await findOpenTrip(client, caravan.id);
      if (!trip) throw conflict("no_trip", "a formation is committed on a trip: ride out first");
      if (!(await chosenCandidate(client, trip.id, n))) throw conflict("no_candidate_chosen", `scout and choose the party for encounter ${n} before committing the circle against it`);
      const committed = await commitFormation(client, caravan, n);
      await rememberLayout(client, caravan, n);
      return committed;
    });
    return { formation };
  });

  // Validation failures carry their issue list so the UI can show every problem at once.
  // Anything else is rethrown to the application-level handler in app.ts.
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof CircleValidationError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, issues: err.issues });
    }
    throw err;
  });
}
