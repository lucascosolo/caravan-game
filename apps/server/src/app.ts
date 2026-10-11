import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthContext } from "./auth/sessions.js";
import { createPool } from "./db/pool.js";
import type { InlineEncounterWorker } from "./dev/testResolver.js";
import { DEFAULT_HANDLERS } from "./jobs/handlers/encounterResolution.js";
import { EncounterWorkerLoop } from "./jobs/inProcessWorker.js";
import { TRIP_SETTLE_HOOKS } from "./trip/service.js";
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
import { tripRoutes } from "./routes/trip.js";
import { unlockRoutes } from "./routes/unlocks.js";
import { AppError } from "./services/errors.js";
import { accountRoutes } from "./routes/account.js";
import { RateLimitedError, RateLimiter, rateLimitsFromEnv, sendRateLimited } from "./account/rateLimit.js";
import type { RateLimitConfig } from "./account/tunables.js";

declare module "fastify" {
  interface FastifyInstance {
    db: pg.Pool;
    /** Dev/test only (chunk 23, CARAVAN_TEST_RESOLVER=double): the test double's handlers. Null in production. */
    inlineEncounterWorker: InlineEncounterWorker | null;
    /** QA-13 S1: the in-process job-queue drain (real resolver by default). Null when not enabled (most tests drain by hand). */
    encounterWorker: EncounterWorkerLoop | null;
    /** Chunk 30: the auth / account routes' fixed-window limiter. */
    rateLimiter: RateLimiter;
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
  /**
   * QA-13 S1: drain the job queue in-process (jobs/inProcessWorker.ts) — with the test double's
   * handlers when `inlineEncounterWorker` is set, else the production DEFAULT_HANDLERS (the real
   * resolver). index.ts passes true. Default: on when `inlineEncounterWorker` is set, else off
   * (tests drain by hand so they can observe "not resolved yet").
   */
  encounterWorker?: boolean | { pollMs?: number };
  /**
   * Chunk 30: the auth / account rate limits. Default: account/tunables.ts RATE_LIMITS, or off
   * when CARAVAN_RATE_LIMITS=off (the server test suite's vitest env; refused in production).
   * null turns them off; a config replaces them (the rate-limit tests pass small ones).
   */
  rateLimits?: RateLimitConfig | null;
  /** Chunk 30: the limiter's clock (tests). */
  rateLimitClock?: () => number;
}

/** Operational: the test double's sweep interval (its kicks do the work). */
const DOUBLE_POLL_MS = 30_000;

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const db = opts.db ?? createPool();
  app.decorate("db", db);
  app.decorate("inlineEncounterWorker", opts.inlineEncounterWorker ?? null);
  app.decorate("rateLimiter", new RateLimiter(opts.rateLimits !== undefined ? opts.rateLimits : rateLimitsFromEnv(process.env), opts.rateLimitClock));
  const inline = opts.inlineEncounterWorker ?? null;
  const workerOpt = opts.encounterWorker ?? inline !== null;
  const loop =
    workerOpt === false
      ? null
      : new EncounterWorkerLoop(db, {
          name: inline ? inline.name : "resolver",
          handlers: inline ? inline.handlers : DEFAULT_HANDLERS,
          kickDelayMs: inline ? inline.delayMs : 0,
          hooks: TRIP_SETTLE_HOOKS,
          // The double keeps its chunk 23 timing: resolved INLINE_WORKER_DELAY_MS after the commit's kick (so a
          // client sees "resolving"), not raced by a 1 s poll; its poll only sweeps up what a kick missed.
          ...(inline ? { retryBackoffMs: () => 0, pollMs: DOUBLE_POLL_MS } : {}),
          ...(typeof workerOpt === "object" && workerOpt.pollMs !== undefined ? { pollMs: workerOpt.pollMs } : {}),
          onError: (err) => app.log.error(err),
          onOutcome: (o) => {
            if (o.kind === "failed" || o.kind === "parked") app.log.warn({ job: o.jobId, error: o.error }, `encounter job ${o.kind}`);
          },
        });
  app.decorate("encounterWorker", loop);
  if (loop) {
    app.addHook("onReady", async () => loop.start());
    app.addHook("onClose", async () => loop.stop());
  }
  if (!opts.db) app.addHook("onClose", async () => db.end());

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof RateLimitedError) return sendRateLimited(reply, err);
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
  await app.register(accountRoutes);
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
  return app;
}
