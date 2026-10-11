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
import { issueSession } from "../auth/sessions.js";
import { toAccountPublic, type AccountRow } from "../db/types.js";
import { clearDeviceCookie, deleteDevice, deleteOtherDevices, deviceIdOfSession, deviceLabel, hashDeviceToken, readDeviceCookie, setDeviceCookie, touchLiveDevice } from "../account/device.js";
import { checkDeletionRequest, createGuest, deletionTerms, deviceViews, eraseAccount, exportAccount, linkAccount } from "../account/service.js";
import { findAccountById } from "../repo/accounts.js";
import { AppError, badRequest, conflict, unauthorized } from "../services/errors.js";
import { requireAuth } from "./require-auth.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown, field: string): string {
  if (typeof value !== "string") throw badRequest("invalid_body", `'${field}' must be a string`);
  return value;
}

export const guestSignOutRefused = () =>
  conflict("guest_sign_out", "a guest account has no password: signing this device out would lose it for good — link a username and password first");

/** The session response every sign-in route sends; a newly created device's credential goes into the HttpOnly cookie, never the body. */
export async function sendSignedIn(req: FastifyRequest, reply: FastifyReply, account: AccountRow, opts: { deviceId?: string; code?: number; extra?: Record<string, unknown> } = {}): Promise<FastifyReply> {
  const s = await issueSession(req.server.db, account.id, opts.deviceId !== undefined ? { deviceId: opts.deviceId } : { label: deviceLabel(req.headers["user-agent"]) });
  if (s.deviceToken !== null) setDeviceCookie(req, reply, s.deviceToken);
  return reply.code(opts.code ?? 200).send({ token: s.token, expiresAt: s.expiresAt.toISOString(), account: toAccountPublic(account), ...(opts.extra ?? {}) });
}

async function currentDeviceId(req: FastifyRequest): Promise<string | null> {
  return deviceIdOfSession(req.server.db, req.auth!.sessionId);
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { region?: unknown; caravanName?: unknown } }>("/auth/guest", async (req, reply) => {
    app.rateLimiter.hit("guestPerIp", req.ip);
    const body = req.body ?? {};
    const input: { regionId: string; caravanName?: string } = { regionId: str(body.region, "region") };
    if (body.caravanName !== undefined) input.caravanName = str(body.caravanName, "caravanName");
    const { account, caravan } = await createGuest(app.db, input);
    return sendSignedIn(req, reply, account, { code: 201, extra: { caravan } });
  });

  app.post("/auth/resume", async (req, reply) => {
    app.rateLimiter.hit("resumePerIp", req.ip);
    const raw = readDeviceCookie(req);
    const device = raw ? await touchLiveDevice(app.db, hashDeviceToken(raw)) : null;
    const account = device ? await findAccountById(app.db, device.account_id) : null;
    if (!device || !account || account.is_system) {
      if (raw) clearDeviceCookie(req, reply);
      throw new AppError(401, "no_device", "no signed-in device here");
    }
    // Slide the cookie's own lifetime with the device's.
    setDeviceCookie(req, reply, raw!);
    return sendSignedIn(req, reply, account, { deviceId: device.id });
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
    const body = await exportAccount(app.db, account.id);
    return reply.header("content-disposition", `attachment; filename="caravan-vaults-export-${account.id}.json"`).header("cache-control", "no-store").send(body);
  });

  app.post<{ Body: { confirm?: unknown; password?: unknown } }>("/me/account/delete", { preHandler: requireAuth }, async (req, reply) => {
    const account = req.auth!.account;
    app.rateLimiter.hit("deletePerAccount", account.id);
    await checkDeletionRequest(account, req.body ?? {});
    const counts = await eraseAccount(app.db, account.id);
    clearDeviceCookie(req, reply);
    return { deleted: true, counts };
  });
}
