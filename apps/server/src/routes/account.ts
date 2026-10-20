/**
 * Chunk 30 routes: guest-first sign-in, linking, devices, export and deletion.
 *
 *   POST   /auth/guest                 { region, caravanName? } → 201 a new GUEST account + caravan + session;
 *                                       sets the device cookie. Rate-limited per IP.
 *   POST   /auth/resume                (device cookie) → 200 a fresh bearer session on that device;
 *                                       401 `no_device` (and the cookie cleared) without a live one.
 *   GET    /me/account                 { account, devices, deletion: {confirmPhrase, requiresPassword} }
 *   POST   /me/account/link            { username, password } → 200 the same account, now linked;
 *                                       409 `already_linked` / `username_taken`. Rate-limited per account.
 *   GET    /me/devices                 { devices } (the current one flagged)
 *   DELETE /me/devices/:id             204; 404 for a device that is not this account's; revoking the
 *                                       CURRENT device of a guest is 409 `guest_sign_out` (it would lose the account)
 *   POST   /me/devices/revoke-others   { revoked } — every other device and its sessions
 *   GET    /me/export                  the account's data as JSON (attachment). Rate-limited per account.
 *   POST   /me/account/delete          { confirm, password? } → 200 { deleted: true, counts }, cookie cleared.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashToken, issueSession } from "../auth/sessions.js";
import { findLiveSessionByTokenHash } from "../repo/sessions.js";
import { toAccountPublic, type AccountRow } from "../db/types.js";
import { clearDeviceCookie, deleteDevice, deleteOtherDevices, deviceIdOfSession, deviceLabel, findLiveDevice, hashDeviceToken, readDeviceCookie, setDeviceCookie, touchLiveDevice } from "../account/device.js";
import { checkDeletionRequest, createGuest, deletionTerms, deviceViews, eraseAccount, exportAccount, linkAccount } from "../account/service.js";
import { findAccountById } from "../repo/accounts.js";
import { passwordFailureLimits } from "../account/rateLimit.js";
import { AppError, badRequest, conflict, unauthorized } from "../services/errors.js";
import { requireAuth } from "./require-auth.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown, field: string): string {
  if (typeof value !== "string") throw badRequest("invalid_body", `'${field}' must be a string`);
  return value;
}

export const guestSignOutRefused = () =>
  conflict("guest_sign_out", "a guest account has no password: leaving it deletes it for good — send { abandon: true } to delete it, or link a username and password first");

/** QA-30 S4: the unlinked guest account this request's device cookie names, if any. */
export async function guestOnDevice(req: FastifyRequest): Promise<{ accountId: string; deviceId: string } | null> {
  const raw = readDeviceCookie(req);
  if (!raw) return null;
  const device = await findLiveDevice(req.server.db, hashDeviceToken(raw));
  if (!device) return null;
  const account = await findAccountById(req.server.db, device.account_id);
  if (!account || account.is_system || account.username !== null) return null;
  return { accountId: account.id, deviceId: device.id };
}

/**
 * QA-30 S4: a new sign-in on a device that holds a guest would overwrite the guest's only key.
 * Refused (409 `guest_on_device`) unless the request says `replaceGuest: true` — and then the
 * guest is ERASED (account_erase, reason guest_replaced) once the new sign-in has succeeded, so
 * it is neither silently lost nor left behind as an unreachable account still being served.
 */
export function refuseGuestReplacement(guest: { accountId: string } | null, body: { replaceGuest?: unknown } | null | undefined): void {
  if (guest && body?.replaceGuest !== true) {
    throw conflict("guest_on_device", "this device holds a guest caravan with no username or password; signing in or starting again here deletes it — send replaceGuest: true to go ahead, or continue it");
  }
}

export async function eraseReplacedGuest(req: FastifyRequest, guest: { accountId: string; deviceId: string } | null, keepAccountId: string): Promise<void> {
  if (!guest || guest.accountId === keepAccountId) return;
  // The proof account_erase asks for: a live session of that guest, issued on its own device.
  const s = await issueSession(req.server.db, guest.accountId, { deviceId: guest.deviceId });
  await eraseAccount(req.server.db, guest.accountId, s.token, "guest_replaced");
}

/** The session response every sign-in route sends; a newly created device's credential goes into the HttpOnly cookie, never the body. */
export async function sendSignedIn(
  req: FastifyRequest,
  reply: FastifyReply,
  account: AccountRow,
  opts: { deviceId?: string; replacesSessionId?: string; code?: number; extra?: Record<string, unknown> } = {},
): Promise<FastifyReply> {
  const s = await issueSession(
    req.server.db,
    account.id,
    opts.deviceId !== undefined
      ? { deviceId: opts.deviceId, ...(opts.replacesSessionId !== undefined ? { replacesSessionId: opts.replacesSessionId } : {}) }
      : { label: deviceLabel(req.headers["user-agent"]) },
  );
  if (s.deviceToken !== null) setDeviceCookie(req, reply, s.deviceToken);
  return reply.code(opts.code ?? 200).send({ token: s.token, expiresAt: s.expiresAt.toISOString(), account: toAccountPublic(account), ...(opts.extra ?? {}) });
}

/** r2 S1: the live session (of this account, on this device) a resume names, by its raw token; else null. */
async function replacedSessionOf(req: FastifyRequest, accountId: string, deviceId: string): Promise<string | null> {
  const body = (req.body ?? {}) as { previousToken?: unknown };
  const fromBody = typeof body.previousToken === "string" && body.previousToken.length > 0 && body.previousToken.length <= 256 ? body.previousToken : null;
  const header = /^Bearer\s+(\S{1,256})$/i.exec(String(req.headers["authorization"] ?? ""));
  const token = fromBody ?? header?.[1] ?? null;
  if (token === null) return null;
  const session = await findLiveSessionByTokenHash(req.server.db, hashToken(token));
  return session && session.account_id === accountId && session.device_id === deviceId ? session.id : null;
}

async function currentDeviceId(req: FastifyRequest): Promise<string | null> {
  return deviceIdOfSession(req.server.db, req.auth!.sessionId);
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { region?: unknown; caravanName?: unknown; replaceGuest?: unknown } }>("/auth/guest", async (req, reply) => {
    app.rateLimiter.hit("guestPerIp", req.ip);
    const body = req.body ?? {};
    const guest = await guestOnDevice(req);
    refuseGuestReplacement(guest, body);
    const input: { regionId: string; caravanName?: string } = { regionId: str(body.region, "region") };
    if (body.caravanName !== undefined) input.caravanName = str(body.caravanName, "caravanName");
    const { account, caravan } = await createGuest(app.db, input);
    await eraseReplacedGuest(req, guest, account.id);
    return sendSignedIn(req, reply, account, { code: 201, extra: { caravan } });
  });

  app.post<{ Querystring: { ifNone?: string } }>("/auth/resume", async (req, reply) => {
    app.rateLimiter.hit("resumePerIp", req.ip);
    // QA-30 N7: a JSON content type forces a CORS preflight, so no page of another origin — or a
    // same-SITE sibling — can make the browser spend this device's sessions with a simple POST.
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new AppError(415, "json_required", "resume takes an application/json request");
    const raw = readDeviceCookie(req);
    const device = raw ? await touchLiveDevice(app.db, hashDeviceToken(raw)) : null;
    const account = device ? await findAccountById(app.db, device.account_id) : null;
    if (!device || !account || account.is_system) {
      if (raw) clearDeviceCookie(req, reply);
      // Final play-test review r3 N10: a cold load on a device that is not signed in is an empty
      // state, not an error. A client that asks for it (`?ifNone=null`) gets 200 `{ session: null }`;
      // without the parameter the answer stays the 401 `no_device` current clients expect.
      if ((req.query as { ifNone?: string } | undefined)?.ifNone === "null") return reply.code(200).send({ session: null });
      throw new AppError(401, "no_device", "no signed-in device here");
    }
    // Slide the cookie's own lifetime with the device's.
    setDeviceCookie(req, reply, raw!);
    // Final play-test review r2 S1: a resume replaces the session it was given (the client's
    // current token, as `Authorization: Bearer …` or `{ previousToken }`), when that is a live
    // session of this same account on this same device; otherwise it is ignored (never an error).
    const replaced = await replacedSessionOf(req, account.id, device.id);
    return sendSignedIn(req, reply, account, { deviceId: device.id, ...(replaced ? { replacesSessionId: replaced } : {}), extra: { replacedPrevious: replaced !== null } });
  });

  app.get("/me/account", { preHandler: requireAuth }, async (req) => {
    const account = req.auth!.account;
    return {
      account: { ...toAccountPublic(account), linkedAt: account.linked_at ? account.linked_at.toISOString() : null },
      devices: await deviceViews(app.db, account.id, await currentDeviceId(req)),
      deletion: deletionTerms(account),
    };
  });

  app.post<{ Body: { username?: unknown; password?: unknown } }>("/me/account/link", { preHandler: requireAuth }, async (req) => {
    const account = req.auth!.account;
    app.rateLimiter.hit("linkPerAccount", account.id);
    if (account.username !== null) throw conflict("already_linked", "this account already has a username and password");
    const body = req.body ?? {};
    const linked = await linkAccount(app.db, account.id, str(body.username, "username"), body.password);
    return { account: { ...toAccountPublic(linked), linkedAt: linked.linked_at ? linked.linked_at.toISOString() : null } };
  });

  app.get("/me/devices", { preHandler: requireAuth }, async (req) => ({ devices: await deviceViews(app.db, req.auth!.account.id, await currentDeviceId(req)) }));

  app.delete<{ Params: { id: string } }>("/me/devices/:id", { preHandler: requireAuth }, async (req, reply) => {
    const account = req.auth!.account;
    const id = req.params.id;
    if (!UUID.test(id)) throw new AppError(404, "no_device", "device not found");
    const current = await currentDeviceId(req);
    if (id === current && account.username === null) throw guestSignOutRefused();
    if (!(await deleteDevice(app.db, account.id, id))) throw new AppError(404, "no_device", "device not found");
    if (id === current) clearDeviceCookie(req, reply);
    return reply.code(204).send();
  });

  app.post("/me/devices/revoke-others", { preHandler: requireAuth }, async (req) => {
    const current = await currentDeviceId(req);
    if (!current) throw unauthorized();
    return { revoked: await deleteOtherDevices(app.db, req.auth!.account.id, current) };
  });

  app.get("/me/export", { preHandler: requireAuth }, async (req, reply) => {
    const account = req.auth!.account;
    app.rateLimiter.hit("exportPerAccount", account.id);
    const text = await exportAccount(app.db, account.id);
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="caravan-vaults-export-${account.id}.json"`)
      .header("cache-control", "no-store")
      .send(text);
  });

  app.post<{ Body: { confirm?: unknown; password?: unknown } }>("/me/account/delete", { preHandler: requireAuth }, async (req, reply) => {
    const account = req.auth!.account;
    app.rateLimiter.hit("deletePerAccount", account.id);
    // QA-30 N3: the password check here shares the login's failure counters (final review D2: per
    // username and address, plus the per-username backstop), so a stolen bearer token is not a
    // second, separately-limited password-guessing channel.
    const failures = account.username !== null ? passwordFailureLimits(app.rateLimiter, account.username, req.ip) : null;
    failures?.check();
    try {
      await checkDeletionRequest(account, req.body ?? {});
    } catch (err) {
      if (err instanceof AppError && err.code === "wrong_password") failures?.fail();
      throw err;
    }
    // The raw bearer token is account_erase's proof of the caller (migration 020); requireAuth has already matched it.
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const counts = await eraseAccount(app.db, account.id, token);
    clearDeviceCookie(req, reply);
    return { deleted: true, counts };
  });
}
