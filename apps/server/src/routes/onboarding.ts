/**
 * Onboarding routes (chunk 24). Account-scoped: the caller's own progress only.
 *
 *   GET  /me/onboarding           where the first-session guide stands
 *   POST /me/onboarding/advance   { step }: move forward to `step` (earlier or equal: no-op, 200)
 *   POST /me/onboarding/skip      skip the rest (409 `onboarding_first_screen` on the first screen)
 *
 * Nothing here grants anything: no Coin, no unit, no unlock point, no access (PHASE-2 §24).
 */
import type { FastifyInstance } from "fastify";
import { withTransaction } from "../db/pool.js";
import { advanceOnboarding, readOnboarding, skipOnboarding } from "../onboarding/service.js";
import { requireAuth } from "./require-auth.js";

const advanceSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["step"],
    properties: { step: { type: "string", maxLength: 32 } },
  },
} as const;

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/onboarding", { preHandler: requireAuth }, async (req) => ({ onboarding: await readOnboarding(app.db, req.auth!.account.id) }));

  app.post<{ Body: { step: string } }>("/me/onboarding/advance", { preHandler: requireAuth, schema: advanceSchema }, async (req) => {
    const accountId = req.auth!.account.id;
    const { changed, ...onboarding } = await withTransaction(app.db, (client) => advanceOnboarding(client, accountId, req.body.step));
    return { onboarding, changed };
  });

  app.post("/me/onboarding/skip", { preHandler: requireAuth }, async (req) => {
    const accountId = req.auth!.account.id;
    const { changed, ...onboarding } = await withTransaction(app.db, (client) => skipOnboarding(client, accountId));
    return { onboarding, changed };
  });
}
