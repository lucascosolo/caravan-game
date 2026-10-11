import type { FastifyInstance } from "fastify";
import { verifyPassword } from "../auth/password.js";
import { PASSWORD_MAX } from "../config.js";
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

/**
 * A real scrypt hash of a throwaway password. Login verifies against it when the username
 * is unknown so the response takes the same time whether or not the account exists
 * (otherwise ~1 ms vs ~50 ms leaks which usernames are registered).
 */
const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$AztxRESPAjZkhhOVaLdDWA$HRnJe7eRWdkKu6lh9pKyHRviCO5jWZmNjmg3PSHRj8Q";

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
    if (password.length > PASSWORD_MAX) throw unauthorized("invalid credentials");
    const account = await findAccountByUsername(app.db, username);
    // Always run the hash, even for an unknown username, so timing doesn't reveal existence.
    const ok = await verifyPassword(password, account ? account.password_hash : DUMMY_PASSWORD_HASH);
    if (!account || !ok) {
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
