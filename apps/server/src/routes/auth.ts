import type { FastifyInstance } from "fastify";
import { verifyPassword } from "../auth/password.js";
import { PASSWORD_MAX } from "../config.js";
import { clearDeviceCookie, deleteDevice, deviceIdOfSession, findLiveDevice, hashDeviceToken, readDeviceCookie } from "../account/device.js";
import { passwordFailureLimits } from "../account/rateLimit.js";
import { revokeSession } from "../auth/sessions.js";
import { findAccountByUsername } from "../repo/accounts.js";
import { badRequest, unauthorized } from "../services/errors.js";
import { normalizeUsername, registerAccount } from "../services/onboarding.js";
import { eraseReplacedGuest, guestOnDevice, guestSignOutRefused, refuseGuestReplacement, sendSignedIn } from "./account.js";
import { eraseAccount } from "../account/service.js";
import { requireAuth } from "./require-auth.js";

interface RegisterBody {
  replaceGuest?: unknown;
  username?: unknown;
  password?: unknown;
  region?: unknown;
  caravanName?: unknown;
}
interface LoginBody {
  replaceGuest?: unknown;
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
    const guest = await guestOnDevice(req);
    refuseGuestReplacement(guest, body);
    const { account, caravan } = await registerAccount(app.db, input);
    await eraseReplacedGuest(req, guest, account.id);
    return sendSignedIn(req, reply, account, { code: 201, extra: { caravan } });
  });

  app.post<{ Body: LoginBody }>("/auth/login", async (req, reply) => {
    app.rateLimiter.hit("loginPerIp", req.ip);
    const body = req.body ?? {};
    // QA-30 D3: a per-device limit too (the device cookie, hashed, when the browser has one).
    const deviceCookie = readDeviceCookie(req);
    if (deviceCookie) app.rateLimiter.hit("loginPerDevice", hashDeviceToken(deviceCookie));
    let username: string;
    try {
      username = normalizeUsername(str(body.username, "username"));
    } catch {
      throw unauthorized("invalid credentials");
    }
    const account = await findAccountByUsername(app.db, username);
    // Final review D2: failures are limited per (username, address) with a generous per-username
    // backstop, so one address cannot lock a player out from everywhere. A browser holding a live
    // device cookie of THIS account has already proved the device and is exempt.
    const failures = passwordFailureLimits(app.rateLimiter, username, req.ip);
    const ownDevice = deviceCookie !== null && account !== null && (await findLiveDevice(app.db, hashDeviceToken(deviceCookie)))?.account_id === account.id;
    if (!ownDevice) failures.check();
    const password = str(body.password, "password");
    if (password.length > PASSWORD_MAX) {
      failures.fail();
      throw unauthorized("invalid credentials");
    }
    // Always run the hash, even for an unknown username, so timing doesn't reveal existence.
    const ok = await verifyPassword(password, account?.password_hash ?? DUMMY_PASSWORD_HASH);
    // Chunk 25 (chunk 14 QA B1): a system account — the non-player owner of an authored
    // party — has no login, whatever its password hash says. Same 401 as a wrong password.
    if (!account || !ok || account.is_system) {
      failures.fail();
      throw unauthorized("invalid credentials");
    }
    failures.succeed();
    // QA-30 S4: only once the credentials are right does the device's guest question arise.
    const guest = await guestOnDevice(req);
    if (guest && guest.accountId !== account.id) refuseGuestReplacement(guest, body);
    await eraseReplacedGuest(req, guest, account.id);
    return sendSignedIn(req, reply, account);
  });

  // Chunk 30: signing out forgets this DEVICE (its cookie and every session it issued). A guest
  // has nothing else to get back in with, so a guest's sign-out needs `{ abandon: true }` — and
  // (QA-30 D2) then ERASES the guest account through account_erase, so nothing is left behind
  // being served into other players' trips with no one able to reach, export or delete it.
  app.post<{ Body: { abandon?: unknown } | null }>("/auth/logout", { preHandler: requireAuth }, async (req, reply) => {
    const { account, sessionId } = req.auth!;
    if (account.username === null) {
      if (req.body?.abandon !== true) throw guestSignOutRefused();
      const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
      await eraseAccount(app.db, account.id, token, "guest_left");
      clearDeviceCookie(req, reply);
      return reply.code(204).send();
    }
    const deviceId = await deviceIdOfSession(app.db, sessionId);
    if (deviceId) await deleteDevice(app.db, account.id, deviceId);
    else await revokeSession(app.db, sessionId);
    clearDeviceCookie(req, reply);
    return reply.code(204).send();
  });
}
