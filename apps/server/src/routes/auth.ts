import type { FastifyInstance } from "fastify";
import { verifyPassword } from "../auth/password.js";
import { PASSWORD_MAX } from "../config.js";
import { clearDeviceCookie, deleteDevice, deviceIdOfSession } from "../account/device.js";
import { revokeSession } from "../auth/sessions.js";
import { findAccountByUsername } from "../repo/accounts.js";
import { badRequest, unauthorized } from "../services/errors.js";
import { normalizeUsername, registerAccount } from "../services/onboarding.js";
import { guestSignOutRefused, sendSignedIn } from "./account.js";
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
    app.rateLimiter.hit("registerPerIp", req.ip);
    const body = req.body ?? {};
    const input: Parameters<typeof registerAccount>[1] = {
      username: str(body.username, "username"),
      password: str(body.password, "password"),
      regionId: str(body.region, "region"),
    };
    if (body.caravanName !== undefined) input.caravanName = str(body.caravanName, "caravanName");
    const { account, caravan } = await registerAccount(app.db, input);
    return sendSignedIn(req, reply, account, { code: 201, extra: { caravan } });
  });

  app.post<{ Body: LoginBody }>("/auth/login", async (req, reply) => {
    app.rateLimiter.hit("loginPerIp", req.ip);
    const body = req.body ?? {};
    if (typeof body.username === "string") app.rateLimiter.hit("loginPerUsername", body.username.trim().toLowerCase().slice(0, 64));
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
    const ok = await verifyPassword(password, account?.password_hash ?? DUMMY_PASSWORD_HASH);
    // Chunk 25 (chunk 14 QA B1): a system account — the non-player owner of an authored
    // party — has no login, whatever its password hash says. Same 401 as a wrong password.
    if (!account || !ok || account.is_system) {
      throw unauthorized("invalid credentials");
    }
    return sendSignedIn(req, reply, account);
  });

  // Chunk 30: signing out forgets this DEVICE (its cookie and every session it issued). A guest
  // has nothing else to get back in with, so a guest's sign-out needs `{ abandon: true }`.
  app.post<{ Body: { abandon?: unknown } | null }>("/auth/logout", { preHandler: requireAuth }, async (req, reply) => {
    const { account, sessionId } = req.auth!;
    if (account.username === null && req.body?.abandon !== true) throw guestSignOutRefused();
    const deviceId = await deviceIdOfSession(app.db, sessionId);
    if (deviceId) await deleteDevice(app.db, account.id, deviceId);
    else await revokeSession(app.db, sessionId);
    clearDeviceCookie(req, reply);
    return reply.code(204).send();
  });
}
