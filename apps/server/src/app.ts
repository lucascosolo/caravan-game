import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import type { AuthContext } from "./auth/sessions.js";
import { createPool } from "./db/pool.js";
import { authRoutes } from "./routes/auth.js";
import { economyRoutes } from "./routes/economy.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { meRoutes } from "./routes/me.js";
import { progressionRoutes } from "./routes/progression.js";
import { AppError } from "./services/errors.js";

declare module "fastify" {
  interface FastifyInstance {
    db: pg.Pool;
  }
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface BuildAppOptions {
  /** Supply a pool (tests); otherwise one is created from DATABASE_URL. */
  db?: pg.Pool;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const db = opts.db ?? createPool();
  app.decorate("db", db);
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
  return app;
}
