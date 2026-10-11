import type { FastifyInstance } from "fastify";
import { verifyPassword } from "../auth/password.js";
import { issueSession, revokeSession } from "../auth/sessions.js";
import { toAccountPublic } from "../db/types.js";
import { findAccountByUsername } from "../repo/accounts.js";
import { badRequest, unauthorized } from "../services/errors.js";
import { normalizeUsername, registerAccount } from "../services/onboarding.js";
import { requireAuth } from "./require-auth.js";

interface RegisterBody {
  username?: unknown;
  password?: unknown;
  region?: unknown;
  caravanName?: unknown;
}
interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string") throw badRequest("invalid_body", `'${field}' must be a string`);
  return value;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterBody }>("/auth/register", async (req, reply) => {
    const body = req.body ?? {};
    const input: Parameters<typeof registerAccount>[1] = {
      username: str(body.username, "username"),
      password: str(body.password, "password"),
      regionId: str(body.region, "region"),
    };
    if (body.caravanName !== undefined) input.caravanName = str(body.caravanName, "caravanName");
    const { account, caravan } = await registerAccount(app.db, input);
    const session = await issueSession(app.db, account.id);
    return reply.code(201).send({
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      account: toAccountPublic(account),
      caravan,
    });
  });

  app.post<{ Body: LoginBody }>("/auth/login", async (req) => {
    const body = req.body ?? {};
    let username: string;
    try {
      username = normalizeUsername(str(body.username, "username"));
    } catch {
      throw unauthorized("invalid credentials");
    }
    const password = str(body.password, "password");
    const account = await findAccountByUsername(app.db, username);
    if (!account || !(await verifyPassword(password, account.password_hash))) {
      throw unauthorized("invalid credentials");
    }
    const session = await issueSession(app.db, account.id);
    return { token: session.token, expiresAt: session.expiresAt.toISOString(), account: toAccountPublic(account) };
  });

  app.post("/auth/logout", { preHandler: requireAuth }, async (req, reply) => {
    await revokeSession(app.db, req.auth!.sessionId);
    return reply.code(204).send();
  });
}
