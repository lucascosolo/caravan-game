import type { FastifyInstance } from "fastify";
import { listEventsForAccount } from "../ledger/ledger.js";
import { listProgressionForAccount, progressionRules } from "../progression/view.js";
import { requireAuth } from "./require-auth.js";

const PROGRESSION_EVENT_TYPES = new Set(["reputation_changed", "ladder_progress_gained", "unlock_points_granted"]);

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

  /** The player's own progression history, oldest first, cursor on seq. */
  app.get<{ Querystring: { after?: string; limit?: string; pool?: string } }>(
    "/me/progression/events",
    { preHandler: requireAuth },
    async (req) => {
      const account = req.auth!.account;
      const afterSeq = Number(req.query.after ?? 0);
      const limit = Number(req.query.limit ?? 100);
      const opts: { afterSeq?: number; limit?: number } = {};
      if (Number.isFinite(afterSeq) && afterSeq >= 0) opts.afterSeq = afterSeq;
      if (Number.isFinite(limit) && limit > 0) opts.limit = limit;
      const page = await listEventsForAccount(app.db, account.id, opts);
      const events = page
        .filter((e) => PROGRESSION_EVENT_TYPES.has(e.event_type))
        .filter((e) => !req.query.pool || e.payload["pool"] === req.query.pool)
        .map((e) => ({
          seq: e.seq,
          type: e.event_type,
          caravanId: e.caravan_id,
          causationId: e.causation_id,
          payload: e.payload,
          occurredAt: e.occurred_at.toISOString(),
        }));
      return { events, nextAfter: page.at(-1)?.seq ?? opts.afterSeq ?? 0 };
    },
  );

  /** Public: the ladder curve, grants per rung and every per-outcome number. Nothing hidden. */
  app.get("/progression/rules", async () => progressionRules());
}
