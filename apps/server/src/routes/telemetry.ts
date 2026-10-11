/**
 * Chunk 32 routes.
 *
 * Player (own account only):
 *   GET  /me/analytics      { optedOut }                   the account's telemetry setting
 *   PUT  /me/analytics      { optedOut: boolean } → same   opting out also deletes kept client events
 *   POST /me/telemetry      { events: [...] } → 202 { accepted, dropped, optedOut }
 *                           screen flow and crash reports only (src/analytics/clientEvents.ts):
 *                           body ≤ TELEMETRY_BODY_LIMIT_BYTES (413), ≤ 25 events, closed
 *                           vocabularies (400), rate-limited per account (429 + Retry-After).
 *
 * Admin (src/analytics/admin.ts requireAdmin: anyone else gets 404, never 401/403):
 *   GET  /admin/dashboard?days=N&week=W   every panel + the §20 tuning table (read-only)
 *
 * There is no route that writes the admin flag. The wall clock enters only here (`Date.now()`),
 * and only to date telemetry and bound the dashboard window — never an outcome.
 */
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../analytics/admin.js";
import { ingest, parseBatch, readSettings, saveSettings, TelemetryRateLimiter } from "../analytics/clientEvents.js";
import { buildDashboard } from "../analytics/dashboard.js";
import { ANALYTICS_DEFAULT_WINDOW_DAYS, ANALYTICS_MAX_WINDOW_DAYS, TELEMETRY_BODY_LIMIT_BYTES } from "../analytics/tunables.js";
import { AppError, badRequest } from "../services/errors.js";
import { requireAuth } from "./require-auth.js";

export interface TelemetryRouteOptions {
  limiter?: TelemetryRateLimiter;
}

export async function telemetryRoutes(app: FastifyInstance, opts: TelemetryRouteOptions = {}): Promise<void> {
  const limiter = opts.limiter ?? new TelemetryRateLimiter();

  app.get("/me/analytics", { preHandler: requireAuth }, async (req) => readSettings(app.db, req.auth!.account.id));

  app.put("/me/analytics", { preHandler: requireAuth }, async (req) => saveSettings(app.db, req.auth!.account.id, req.body ?? null));

  app.post(
    "/me/telemetry",
    {
      bodyLimit: TELEMETRY_BODY_LIMIT_BYTES,
      // Authenticate and rate-limit BEFORE the body is read: a flood costs a token lookup, not a parse.
      onRequest: async (req, reply) => {
        await requireAuth(req, reply);
        const take = limiter.take(req.auth!.account.id, Date.now());
        if (!take.ok) {
          void reply.header("Retry-After", String(Math.max(1, Math.ceil(take.retryAfterMs / 1000))));
          throw new AppError(429, "telemetry_rate_limited", "too many telemetry batches; try again shortly");
        }
      },
    },
    async (req, reply) => {
      const events = parseBatch(req.body ?? null);
      const result = await ingest(app.db, req.auth!.account.id, events, Date.now());
      return reply.code(202).send(result);
    },
  );

  app.get("/admin/dashboard", { preHandler: requireAdmin }, async (req) => {
    const query = req.query as Record<string, string | undefined>;
    const days = query["days"] === undefined ? ANALYTICS_DEFAULT_WINDOW_DAYS : Number(query["days"]);
    if (!Number.isInteger(days) || days < 1 || days > ANALYTICS_MAX_WINDOW_DAYS) throw badRequest("invalid_window", `days must be an integer 1..${ANALYTICS_MAX_WINDOW_DAYS}`);
    let week: number | undefined;
    if (query["week"] !== undefined) {
      week = Number(query["week"]);
      if (!Number.isInteger(week)) throw badRequest("invalid_week", "week must be an integer pack-rotation week index");
    }
    return buildDashboard(app.db, { nowMs: Date.now(), days, ...(week === undefined ? {} : { week }) });
  });

  // Any other /admin/* path answers exactly like a non-admin request: 404.
  app.all("/admin/*", async () => {
    throw new AppError(404, "not_found", "not found");
  });
}
