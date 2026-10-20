import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type pg from "pg";
import type { AuthContext } from "./auth/sessions.js";
import { createPool } from "./db/pool.js";
import { storeModeFromEnv, trustProxyFromEnv, type ServeWebConfig, type StoreMode } from "./config.js";
import { webStaticRoutes } from "./web/static.js";
import type { InlineEncounterWorker } from "./dev/testResolver.js";
import { DEFAULT_HANDLERS } from "./jobs/handlers/encounterResolution.js";
import { EncounterWorkerLoop } from "./jobs/inProcessWorker.js";
import { LogRetentionLoop } from "./jobs/retentionWorker.js";
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
import { telemetryRoutes } from "./routes/telemetry.js";
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
    /** PHASE-2 §36: the scheduled replay-retention sweep (compaction). Null when not enabled (tests sweep by hand). */
    retentionJob: LogRetentionLoop | null;
    /** Chunk 30: the auth / account routes' fixed-window limiter. */
    rateLimiter: RateLimiter;
    /** Final review D1: "off" refuses purchases (409 store_unavailable) and hides the store funnel. */
    storeMode: StoreMode;
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
   * PHASE-2 §36: run the replay-retention sweep in-process (jobs/retentionWorker.ts) — logs past
   * LOG_RETENTION or over LOG_SIZE_BUDGET compacted to their results summary. index.ts passes true.
   * Default off (tests call the sweep themselves).
   */
  retentionJob?: boolean | { intervalMs?: number };
  /**
   * Chunk 30: the auth / account rate limits. Default: account/tunables.ts RATE_LIMITS, or off
   * when CARAVAN_RATE_LIMITS=off (the server test suite's vitest env; refused in production).
   * null turns them off; a config replaces them (the rate-limit tests pass small ones).
   */
  rateLimits?: RateLimitConfig | null;
  /** QA-30 D3: Fastify's trustProxy (default: TRUST_PROXY from the environment, off). */
  trustProxy?: false | number | string;
  /** Chunk 30: the limiter's clock (tests). */
  rateLimitClock?: () => number;
  /** Final review D1: whether packs can be bought. Default: STORE_MODE from the environment (off under NODE_ENV=production). */
  storeMode?: StoreMode;
  /** Final review S2: serve the built client and mount the API under /api. Default none (index.ts passes SERVE_WEB's config). */
  serveWeb?: ServeWebConfig | null;
}

/** Operational: the test double's sweep interval (its kicks do the work). */
const DOUBLE_POLL_MS = 30_000;

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  // QA-30 D3: off unless TRUST_PROXY names the proxy (hop count or addresses); "true" is refused.
  const trust = opts.trustProxy !== undefined ? opts.trustProxy : trustProxyFromEnv(process.env);
  // A hop count becomes the equivalent function (the address n hops from the socket is the client).
  const fastifyOptions: FastifyServerOptions = { logger: opts.logger ?? false, trustProxy: typeof trust === "number" ? (_addr: string, hop: number) => hop < trust : trust };
  const app = Fastify(fastifyOptions);
  const db = opts.db ?? createPool();
  app.decorate("db", db);
  app.decorate("storeMode", opts.storeMode ?? storeModeFromEnv(process.env));
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
          // QA-36 N2: an abnormal log — its defender gets the summary, not a replay. Count these.
          onLogOverBudget: (jobId, storedBytes, budgetBytes) =>
            app.log.warn({ job: jobId, storedBytes, budgetBytes, anomaly: "replay_log_over_size_budget" }, "replay log over LOG_SIZE_BUDGET: compacted at write"),
          onOutcome: (o) => {
            if (o.kind === "failed" || o.kind === "parked") app.log.warn({ job: o.jobId, error: o.error }, `encounter job ${o.kind}`);
          },
          // Final guardrail review r3 S1: fights committed under another resolver version (an upgrade
          // without a drain, or a crash during one): parked, and each trip voided.
          onParkedOtherVersion: (jobs) =>
            app.log.warn(
              { jobs: jobs.map((j) => ({ job: j.id, resolverVersion: (j.input as { resolverVersion?: unknown }).resolverVersion })) },
              `${jobs.length} job(s) of another resolver version parked and their trips voided (docs/PLAYTEST-HOSTING.md step 12: drain before an upgrade that bumps RESOLVER_VERSION)`,
            ),
        });
  app.decorate("encounterWorker", loop);
  if (loop) {
    app.addHook("onReady", async () => loop.start());
  }
  const retention =
    opts.retentionJob === undefined || opts.retentionJob === false
      ? null
      : new LogRetentionLoop(db, {
          ...(typeof opts.retentionJob === "object" && opts.retentionJob.intervalMs !== undefined ? { intervalMs: opts.retentionJob.intervalMs } : {}),
          onError: (err) => app.log.error(err),
          onRun: (r) => app.log.info(r, `retention: ${r.compacted} replay log(s) compacted to their results summary, ${r.guestsErased} expired guest(s) erased`),
        });
  app.decorate("retentionJob", retention);
  if (retention) {
    app.addHook("onReady", async () => retention.start());
  }
  // Final guardrail review r2 N4: ONE onClose hook, so the order is explicit (Fastify does not run
  // separate onClose hooks in registration order): the encounter worker stops leasing and finishes
  // the fight it holds, the retention sweep stops, and only then is the pool this app created closed.
  app.addHook("onClose", async () => {
    if (loop) await loop.stop();
    if (retention) await retention.stop();
    if (!opts.db) await db.end();
  });

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

  const health = async (): Promise<{ ok: true }> => {
    await db.query("SELECT 1");
    return { ok: true };
  };
  // Final review S2: under SERVE_WEB the API lives under /api (the client's origin and prefix);
  // /health also stays at the root, for the process manager and the reverse proxy's health check.
  const serveWeb = opts.serveWeb ?? null;
  if (serveWeb) app.get("/health", health);

  await app.register(
    async (api) => {
      api.addHook("onSend", async (_req, reply, payload) => {
        void reply.header("x-content-type-options", "nosniff");
        // Hosted: API answers are per-player and never cached by a proxy or the browser.
        if (serveWeb && !reply.hasHeader("cache-control")) void reply.header("cache-control", "no-store");
        return payload;
      });
      api.get("/health", health);
      await api.register(authRoutes);
      await api.register(accountRoutes);
      await api.register(meRoutes);
      await api.register(ledgerRoutes);
      await api.register(progressionRoutes);
      await api.register(economyRoutes);
      await api.register(circleRoutes);
      await api.register(unlockRoutes);
      await api.register(acquisitionRoutes);
      await api.register(partyRoutes);
      await api.register(matchmakingRoutes);
      await api.register(storeRoutes);
      await api.register(cosmeticRoutes);
      await api.register(tripRoutes);
      await api.register(replayRoutes);
      await api.register(inboxRoutes);
      await api.register(onboardingRoutes);
      // Chunk 32: client telemetry (screen flow, crashes), the opt-out, and the admin-only dashboard.
      await api.register(telemetryRoutes);
    },
    { prefix: serveWeb ? "/api" : "" },
  );
  if (serveWeb) await app.register(async (web) => webStaticRoutes(web, serveWeb));
  return app;
}
