import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthContext } from "./auth/sessions.js";
import { createPool } from "./db/pool.js";
import type { InlineEncounterWorker } from "./dev/testResolver.js";
import { acquisitionRoutes } from "./routes/acquisition.js";
import { authRoutes } from "./routes/auth.js";
import { circleRoutes } from "./routes/circle.js";
import { cosmeticRoutes } from "./routes/cosmetics.js";
import { economyRoutes } from "./routes/economy.js";
import { inboxRoutes } from "./routes/inbox.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { matchmakingRoutes } from "./routes/matchmaking.js";
import { meRoutes } from "./routes/me.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { partyRoutes } from "./routes/party.js";
import { progressionRoutes } from "./routes/progression.js";
import { storeRoutes } from "./routes/store.js";
import { replayRoutes } from "./routes/replay.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { tripRoutes } from "./routes/trip.js";
import { unlockRoutes } from "./routes/unlocks.js";
import { AppError } from "./services/errors.js";

declare module "fastify" {
  interface FastifyInstance {
    db: pg.Pool;
    /** Dev/test only (chunk 23, CARAVAN_TEST_RESOLVER=double): resolve committed encounters in-process. Null in production. */
    inlineEncounterWorker: InlineEncounterWorker | null;
  }
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface BuildAppOptions {
  /** Supply a pool (tests); otherwise one is created from DATABASE_URL. */
  db?: pg.Pool;
  logger?: boolean;
  /** Dev/test only: see src/dev/testResolver.ts. index.ts passes `inlineWorkerFromEnv(process.env)`. */
  inlineEncounterWorker?: InlineEncounterWorker | null;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const db = opts.db ?? createPool();
  app.decorate("db", db);
  app.decorate("inlineEncounterWorker", opts.inlineEncounterWorker ?? null);
  if (!opts.db) app.addHook("onClose", async () => db.end());

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal", message: "internal error" });
  });

  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(ledgerRoutes);
  await app.register(progressionRoutes);
  await app.register(economyRoutes);
  await app.register(circleRoutes);
  await app.register(unlockRoutes);
  await app.register(acquisitionRoutes);
  await app.register(partyRoutes);
  await app.register(matchmakingRoutes);
  await app.register(storeRoutes);
  await app.register(cosmeticRoutes);
  await app.register(tripRoutes);
  await app.register(replayRoutes);
  await app.register(inboxRoutes);
  await app.register(onboardingRoutes);
  // Chunk 32: client telemetry (screen flow, crashes), the opt-out, and the admin-only dashboard.
  await app.register(telemetryRoutes);
  return app;
}
