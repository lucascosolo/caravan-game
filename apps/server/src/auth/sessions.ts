/**
 * Opaque bearer tokens. The raw token is returned to the client once; only its SHA-256
 * is stored. Authorization header: `Bearer <token>`.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { SESSION_TTL_MS } from "../config.js";
import type { AccountRow } from "../db/types.js";
import { findAccountById } from "../repo/accounts.js";
import { deleteSession, findLiveSessionByTokenHash, insertSession } from "../repo/sessions.js";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueSession(db: pg.Pool | pg.PoolClient, accountId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await insertSession(db, { accountId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

export interface AuthContext {
  sessionId: string;
  account: AccountRow;
}

/** Resolve a bearer token to its account, or null if missing/expired/unknown. */
export async function authenticate(db: pg.Pool, authorizationHeader: string | undefined): Promise<AuthContext | null> {
  if (!authorizationHeader) return null;
  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  const session = await findLiveSessionByTokenHash(db, hashToken(token));
  if (!session) return null;
  const account = await findAccountById(db, session.account_id);
  if (!account) return null;
  return { sessionId: session.id, account };
}

export async function revokeSession(db: pg.Pool, sessionId: string): Promise<void> {
  await deleteSession(db, sessionId);
}
