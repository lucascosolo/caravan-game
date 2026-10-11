import type { FastifyInstance } from "fastify";
import type { Pool } from "../db/types.js";
import { AppError } from "../services/errors.js";
import {
  listProgressionEventsForAccount,
  listProgressionForAccount,
  PROGRESSION_EVENTS_LIMIT_DEFAULT,
  PROGRESSION_EVENTS_LIMIT_MAX,
  progressionRules,
} from "../progression/view.js";
import { requireAuth } from "./require-auth.js";

interface EventsQuery {
  after?: number;
  limit?: number;
  pool?: Pool;
}

/**
 * Query schema for the history endpoint (QA S4): Fastify validates and coerces the raw
 * strings, so a malformed cursor, limit or pool is a 400, never a silent default or a 500.
 * `after` is bounded by 2^53 − 1 because seq is read as a Number (see db/pool.ts).
 */
const EVENTS_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: PROGRESSION_EVENTS_LIMIT_MAX, default: PROGRESSION_EVENTS_LIMIT_DEFAULT },
    pool: { type: "string", enum: ["living", "trap", "siege"] },
  },
} as const;
const EVENTS_QUERY_KEYS = new Set(Object.keys(EVENTS_QUERY_SCHEMA.properties));

/**
 * Read endpoints for ladders and Reputation. Read-only by construction: there is no POST
 * here — progression moves only when an encounter resolves (progression/outcome.ts).
 */
export async function progressionRoutes(app: FastifyInstance): Promise<void> {
  /** Every ladder and rating the player owns: trap/siege on the account, living per caravan. */
  app.get("/me/progression", { preHandler: requireAuth }, async (req) => {
    const account = req.auth!.account;
    return { pools: await listProgressionForAccount(app.db, account.id) };
  });

  /** The player's own progression history, oldest first, cursor on seq; filters apply in SQL. */
  app.get<{ Querystring: EventsQuery }>(
    "/me/progression/events",
    {
      schema: { querystring: EVENTS_QUERY_SCHEMA },
      // Ajv's removeAdditional would silently drop unknown keys; an unknown key is a
      // malformed query and gets a 400 like the rest.
      preValidation: async (req) => {
        const unknown = Object.keys((req.query ?? {}) as object).filter((k) => !EVENTS_QUERY_KEYS.has(k));
        if (unknown.length > 0) throw new AppError(400, "bad_request", `unknown query parameter(s): ${unknown.join(", ")}`);
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const account = req.auth!.account;
      const opts: { afterSeq?: number; limit?: number; pool?: Pool } = {};
      if (req.query.after !== undefined) opts.afterSeq = req.query.after;
      if (req.query.limit !== undefined) opts.limit = req.query.limit;
      if (req.query.pool !== undefined) opts.pool = req.query.pool;
      const page = await listProgressionEventsForAccount(app.db, account.id, opts);
      return {
        events: page.events.map((e) => ({
          seq: e.seq,
          type: e.event_type,
          caravanId: e.caravan_id,
          causationId: e.causation_id,
          payload: e.payload,
          occurredAt: e.occurred_at.toISOString(),
        })),
        nextAfter: page.nextAfter,
        hasMore: page.hasMore,
      };
    },
  );

  /** Public: the ladder curve, grants per rung and every per-outcome number. Nothing hidden. */
  app.get("/progression/rules", async () => progressionRules());
}
