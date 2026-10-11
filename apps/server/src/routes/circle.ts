/**
 * Wagon circle routes (chunk 07). All caravan-scoped and owner-only: a caravan that is not
 * the caller's is a 404, never a hint that it exists.
 *
 *   POST /caravans/:caravanId/manifest                               pack & lock (town → trail)
 *   GET  /caravans/:caravanId/manifest                               the open manifest + survivors + stakes summary
 *   PUT  /caravans/:caravanId/encounters/:n/formation                draft / re-draft the next encounter's arrangement
 *   GET  /caravans/:caravanId/encounters/:n/formation                read it (and its gaps)
 *   POST /caravans/:caravanId/encounters/:n/formation/commit         freeze it
 *
 * There is deliberately no route that edits a manifest, applies an outcome, or closes a
 * manifest: the first does not exist anywhere, the other two belong to the resolution path
 * and the trip loop (chunks 13/15), not to a client.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTransaction } from "../db/pool.js";
import type { CaravanRow } from "../db/types.js";
import { findCaravanById } from "../repo/caravans.js";
import { badRequest } from "../services/errors.js";
import {
  CircleValidationError,
  commitFormation,
  getFormation,
  getOpenManifest,
  lockManifest,
  manifestView,
  notFound,
  saveFormation,
  type PackRequest,
} from "../circle/service.js";
import { requireAuth } from "./require-auth.js";

type CaravanParams = { caravanId: string };
type EncounterParams = CaravanParams & { n: string };

/** QA S4: a real UUID (8-4-4-4-12 hex), not merely 36 characters of hex and dashes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownCaravan(req: FastifyRequest<{ Params: CaravanParams }>): Promise<CaravanRow> {
  const caravan = UUID.test(req.params.caravanId) ? await findCaravanById(req.server.db, req.params.caravanId) : null;
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

  app.get<{ Params: CaravanParams }>("/caravans/:caravanId/manifest", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    const row = await getOpenManifest(app.db, caravan.id);
    return { manifest: await manifestView(app.db, row) };
  });

  app.put<{ Params: EncounterParams }>("/caravans/:caravanId/encounters/:n/formation", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    const n = encounterIndex(req.params.n);
    const formation = await withTransaction(app.db, (client) => saveFormation(client, caravan, n, req.body));
    return { formation };
  });

  app.get<{ Params: EncounterParams }>("/caravans/:caravanId/encounters/:n/formation", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    return { formation: await getFormation(app.db, caravan, encounterIndex(req.params.n)) };
  });

  app.post<{ Params: EncounterParams }>("/caravans/:caravanId/encounters/:n/formation/commit", { preHandler: requireAuth }, async (req) => {
    const caravan = await ownCaravan(req);
    const n = encounterIndex(req.params.n);
    const formation = await withTransaction(app.db, (client) => commitFormation(client, caravan, n));
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
