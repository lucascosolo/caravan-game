/**
 * Chunk 30: devices — the credential that lets a reload (and a guest above all) get back into
 * the same account without the page ever storing anything.
 *
 * WHY A COOKIE, AND WHY THIS ONE. The client keeps its bearer token in memory only and writes
 * nothing to localStorage / sessionStorage / IndexedDB (game state never lives in the browser).
 * A guest has no username or password, so without a credential that survives a reload a guest
 * would lose their account to the first refresh. The device credential is therefore set by the
 * SERVER as a cookie the page cannot read or write:
 *   HttpOnly            no script can read it, so an XSS cannot exfiltrate it;
 *   SameSite=Strict     never sent on a cross-site request;
 *   Secure              whenever the request came over https (and always under NODE_ENV=production);
 *   Path=/              the dev proxy strips /api, so the browser-visible path differs from the
 *                       server's; the cookie is honoured ONLY by POST /auth/resume and
 *                       /auth/logout. Every game route authenticates by the bearer header alone,
 *                       so a cookie riding along on any other request authorizes nothing (no CSRF).
 * Its raw value is 32 random bytes; the database stores only the sha256. A resume trades it for
 * a fresh bearer session tied to the device, and slides the device's expiry forward. The value
 * itself is not rotated on resume: two tabs resuming at once must not lock each other out (a
 * rotated-away cookie would leave a guest with no way back in).
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Queryable } from "../db/pool.js";
import { DEVICE_COOKIE, DEVICE_TTL_MS, DEVICES_PER_ACCOUNT_MAX } from "./tunables.js";

export interface DeviceRow {
  id: string;
  account_id: string;
  token_hash: string;
  label: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

export const hashDeviceToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");

export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A short label from the User-Agent: browser and platform only, nothing finer (no version, no IP). */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser =
    /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const platform =
    /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return `Browser on ${platform}`;
  return "Unknown device";
}

/** The device cookie's value from a Cookie header, or null. */
export function readDeviceCookie(req: FastifyRequest): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== DEVICE_COOKIE) continue;
    const v = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
  }
  return null;
}

function secure(req: FastifyRequest): boolean {
  return process.env["NODE_ENV"] === "production" || req.protocol === "https";
}

export function setDeviceCookie(req: FastifyRequest, reply: FastifyReply, raw: string): void {
  const attrs = [`${DEVICE_COOKIE}=${raw}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(DEVICE_TTL_MS / 1000)}`];
  if (secure(req)) attrs.push("Secure");
  reply.header("set-cookie", attrs.join("; "));
}

export function clearDeviceCookie(req: FastifyRequest, reply: FastifyReply): void {
  const attrs = [`${DEVICE_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure(req)) attrs.push("Secure");
  reply.header("set-cookie", attrs.join("; "));
}

export async function insertDevice(db: Queryable, input: { accountId: string; tokenHash: string; label: string }): Promise<DeviceRow> {
  const res = await db.query<DeviceRow>(
    `INSERT INTO device (account_id, token_hash, label, expires_at) VALUES ($1, $2, $3, now() + ($4::bigint * interval '1 millisecond')) RETURNING *`,
    [input.accountId, input.tokenHash, input.label.slice(0, 120) || "Unknown device", DEVICE_TTL_MS],
  );
  return res.rows[0]!;
}

/** A live device by its cookie's hash; slides its expiry and marks it seen. */
export async function touchLiveDevice(db: Queryable, tokenHash: string): Promise<DeviceRow | null> {
  const res = await db.query<DeviceRow>(
    `UPDATE device SET last_seen_at = now(), expires_at = now() + ($2::bigint * interval '1 millisecond')
      WHERE token_hash = $1 AND expires_at > now() RETURNING *`,
    [tokenHash, DEVICE_TTL_MS],
  );
  return res.rows[0] ?? null;
}

export async function listDevices(db: Queryable, accountId: string): Promise<DeviceRow[]> {
  const res = await db.query<DeviceRow>("SELECT * FROM device WHERE account_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC, id", [accountId]);
  return res.rows;
}

export async function deleteDevice(db: Queryable, accountId: string, deviceId: string): Promise<boolean> {
  const res = await db.query("DELETE FROM device WHERE id = $1 AND account_id = $2", [deviceId, accountId]);
  return (res.rowCount ?? 0) > 0;
}

export async function deleteOtherDevices(db: Queryable, accountId: string, keepDeviceId: string): Promise<number> {
  const res = await db.query("DELETE FROM device WHERE account_id = $1 AND id <> $2", [accountId, keepDeviceId]);
  return res.rowCount ?? 0;
}

export async function deviceIdOfSession(db: Queryable, sessionId: string): Promise<string | null> {
  const res = await db.query<{ device_id: string }>("SELECT device_id FROM session WHERE id = $1", [sessionId]);
  return res.rows[0]?.device_id ?? null;
}

/** Housekeeping: expired devices go (with their sessions); then only the newest-seen DEVICES_PER_ACCOUNT_MAX stay. */
export async function pruneDevices(db: Queryable, accountId: string, cap: number = DEVICES_PER_ACCOUNT_MAX): Promise<void> {
  await db.query("DELETE FROM device WHERE account_id = $1 AND expires_at <= now()", [accountId]);
  await db.query(
    `DELETE FROM device WHERE id IN (
       SELECT id FROM device WHERE account_id = $1 ORDER BY last_seen_at DESC, created_at DESC, id DESC OFFSET $2
     )`,
    [accountId, cap],
  );
}
