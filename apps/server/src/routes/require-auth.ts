import type { FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../auth/sessions.js";
import { unauthorized } from "../services/errors.js";

/** Fastify preHandler: resolves the bearer token or rejects with 401. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const ctx = await authenticate(req.server.db, req.headers.authorization);
  if (!ctx) throw unauthorized();
  req.auth = ctx;
}
