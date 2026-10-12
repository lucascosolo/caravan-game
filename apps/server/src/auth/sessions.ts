/**
 * Opaque bearer tokens. The raw token is returned to the client once; only its SHA-256
 * is stored. Authorization header: `Bearer <token>`.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { SESSIONS_PER_ACCOUNT_MAX, SESSION_TTL_MS } from "../config.js";
import type { AccountRow } from "../db/types.js";
import { findAccountById } from "../repo/accounts.js";
import { hashDeviceToken, insertDevice, newDeviceToken, pruneDevices } from "../account/device.js";
import { DEVICE_SESSIONS_MAX, SESSION_TOUCH_INTERVAL_MS } from "../account/tunables.js";
import {
  deleteSession,
  evictDeviceSessionsBeyondCap,
  evictSessionsBeyondCap,
  findLiveSessionByTokenHash,
  insertSession,
  touchSession,
  purgeExpiredSessions,
} from "../repo/sessions.js";

/** Exactly `Bearer <token>`: one token, no trailing junk, scheme case-insensitive. */
const BEARER_RE = /^Bearer\s+(\S+)$/i;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Chunk 25 QA S6: a system account (the non-player owner of an authored party) never holds
 * a session, whatever path asks for one — not just the login route. issueSession refuses
 * to mint one and authenticate refuses to honour one, so a session row for a system
 * account (however it got there) authenticates nothing.
 */
export class SystemAccountSessionError extends Error {
  constructor(public readonly accountId: string) {
    super(`account ${accountId} is a system account and cannot hold a session`);
    this.name = "SystemAccountSessionError";
  }
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  sessionId: string;
  deviceId: string;
  /** Chunk 30: the raw device credential, only when this call created the device (the route sets it as the HttpOnly cookie). */
  deviceToken: string | null;
}

/**
 * Chunk 30: every session belongs to a device. Without `deviceId` (a sign-in: register, login,
 * guest creation) a new device is created and its raw credential returned once; with one (a
 * resume) the session joins that device, which keeps at most DEVICE_SESSIONS_MAX sessions.
 */
export async function issueSession(
  db: pg.Pool | pg.PoolClient,
  accountId: string,
  opts: { deviceId?: string; label?: string } = {},
): Promise<IssuedSession> {
  const account = await findAccountById(db, accountId);
  if (!account) throw new Error(`account ${accountId} not found; cannot issue a session`);
  if (account.is_system) throw new SystemAccountSessionError(accountId);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  // Housekeeping on the login path: drop this account's expired rows, then cap the live
  // ones so a leaked credential can't grow the table without bound.
  await purgeExpiredSessions(db, accountId);
  let deviceId = opts.deviceId ?? null;
  let deviceToken: string | null = null;
  if (deviceId === null) {
    deviceToken = newDeviceToken();
    deviceId = (await insertDevice(db, { accountId, tokenHash: hashDeviceToken(deviceToken), label: opts.label ?? "Unknown device" })).id;
  }
  const session = await insertSession(db, { accountId, token, expiresAt, deviceId });
  if (opts.deviceId !== undefined) await evictDeviceSessionsBeyondCap(db, deviceId, DEVICE_SESSIONS_MAX);
  await pruneDevices(db, accountId);
  await evictSessionsBeyondCap(db, accountId, SESSIONS_PER_ACCOUNT_MAX);
  return { token, expiresAt, sessionId: session.id, deviceId, deviceToken };
}

export interface AuthContext {
  sessionId: string;
  account: AccountRow;
}

/** Resolve a bearer token to its account, or null if missing/expired/unknown. */
export async function authenticate(db: pg.Pool, authorizationHeader: string | undefined): Promise<AuthContext | null> {
  if (!authorizationHeader) return null;
  const match = BEARER_RE.exec(authorizationHeader);
  if (!match) return null;
  const token = match[1]!;
  const session = await findLiveSessionByTokenHash(db, hashToken(token));
  if (!session) return null;
  const account = await findAccountById(db, session.account_id);
  if (!account || account.is_system) return null;
  // QA-30 S4: least-recently-used eviction needs a use time; written at most once per interval.
  if (session.last_used_at.getTime() <= session.created_at.getTime() || Date.now() - session.last_used_at.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await touchSession(db, session.id, SESSION_TOUCH_INTERVAL_MS);
  }
  return { sessionId: session.id, account };
}

export async function revokeSession(db: pg.Pool, sessionId: string): Promise<void> {
  await deleteSession(db, sessionId);
}
