/**
 * Opaque bearer tokens. The raw token is returned to the client once; only its SHA-256
 * is stored. Authorization header: `Bearer <token>`.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { SESSIONS_PER_ACCOUNT_MAX, SESSION_TTL_MS } from "../config.js";
import type { AccountRow } from "../db/types.js";
import { findAccountById } from "../repo/accounts.js";
import {
  deleteSession,
  evictSessionsBeyondCap,
  findLiveSessionByTokenHash,
  insertSession,
  purgeExpiredSessions,
} from "../repo/sessions.js";

/** Exactly `Bearer <token>`: one token, no trailing junk, scheme case-insensitive. */
const BEARER_RE = /^Bearer\s+(\S+)$/i;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueSession(db: pg.Pool | pg.PoolClient, accountId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  // Housekeeping on the login path: drop this account's expired rows, then cap the live
  // ones so a leaked credential can't grow the table without bound.
  await purgeExpiredSessions(db, accountId);
  await insertSession(db, { accountId, tokenHash: hashToken(token), expiresAt });
  await evictSessionsBeyondCap(db, accountId, SESSIONS_PER_ACCOUNT_MAX);
  return { token, expiresAt };
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
  if (!account) return null;
  return { sessionId: session.id, account };
}

export async function revokeSession(db: pg.Pool, sessionId: string): Promise<void> {
  await deleteSession(db, sessionId);
}
