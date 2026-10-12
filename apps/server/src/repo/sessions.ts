import type { Queryable } from "../db/pool.js";
import type { SessionRow } from "../db/types.js";

/**
 * QA-30 S1: the one way a session is created — session_issue() (SECURITY DEFINER, migration 023)
 * hashes the RAW token inside the database; the app role has no INSERT on `session`. Without a
 * device id the database gives the session a device of its own (migration 020).
 */
export async function insertSession(
  db: Queryable,
  input: { accountId: string; token: string; expiresAt: Date; deviceId?: string },
): Promise<SessionRow> {
  const res = await db.query<SessionRow>("SELECT * FROM session_issue($1, $2, $3, $4)", [input.accountId, input.deviceId ?? null, input.token, input.expiresAt]);
  return res.rows[0]!;
}

/** QA-30 S4: mark a session used (at most once per SESSION_TOUCH_INTERVAL_MS), so eviction is least-recently-used. */
export async function touchSession(db: Queryable, sessionId: string, intervalMs: number): Promise<void> {
  await db.query("UPDATE session SET last_used_at = now() WHERE id = $1 AND (last_used_at <= created_at OR last_used_at < now() - ($2::bigint * interval '1 millisecond'))", [sessionId, intervalMs]);
}

/** Returns the session only if it exists and has not expired. */
export async function findLiveSessionByTokenHash(db: Queryable, tokenHash: string): Promise<SessionRow | null> {
  const res = await db.query<SessionRow>(
    "SELECT * FROM session WHERE token_hash = $1 AND expires_at > now()",
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

export async function deleteSession(db: Queryable, id: string): Promise<void> {
  await db.query("DELETE FROM session WHERE id = $1", [id]);
}

/** Remove an account's expired sessions. Returns how many were removed. */
export async function purgeExpiredSessions(db: Queryable, accountId: string): Promise<number> {
  const res = await db.query("DELETE FROM session WHERE account_id = $1 AND expires_at <= now()", [accountId]);
  return res.rowCount ?? 0;
}

/** Keep only the `cap` newest sessions for an account (oldest evicted). Returns how many went. */
export async function evictSessionsBeyondCap(db: Queryable, accountId: string, cap: number, keepId?: string): Promise<number> {
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`session cap must be a positive integer, got ${cap}`);
  const res = await db.query(
    `DELETE FROM session WHERE id IN (
       SELECT id FROM session WHERE account_id = $1 AND ($3::uuid IS NULL OR id <> $3::uuid)
       -- QA-30 S4: keep sessions in use (authenticated in the last 5 minutes) first, then the most recently used / issued.
       -- Final play-test review r2 S1: the session being issued (keepId) is never a candidate — it is
       -- kept and counts toward the cap, so the others are cut to cap − 1. (Before, a brand-new
       -- session sorted after every session in use and could be deleted the moment it was issued.)
       ORDER BY (last_used_at > created_at AND last_used_at > now() - interval '5 minutes') DESC, last_used_at DESC, created_at DESC, id DESC OFFSET $2
     )`,
    [accountId, keepId === undefined ? cap : cap - 1, keepId ?? null],
  );
  return res.rowCount ?? 0;
}

/** Chunk 30: keep only a device's `cap` newest sessions (several tabs of one browser). */
export async function evictDeviceSessionsBeyondCap(db: Queryable, deviceId: string, cap: number, keepId?: string): Promise<number> {
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`session cap must be a positive integer, got ${cap}`);
  const res = await db.query(
    `DELETE FROM session WHERE id IN (
       SELECT id FROM session WHERE device_id = $1 AND ($3::uuid IS NULL OR id <> $3::uuid)
       -- QA-30 S4: keep sessions in use (authenticated in the last 5 minutes) first, then the most recently used / issued.
       -- Final play-test review r2 S1: the session being issued (keepId) is never a candidate — it is
       -- kept and counts toward the cap, so the others are cut to cap − 1. (Before, a brand-new
       -- session sorted after every session in use and could be deleted the moment it was issued.)
       ORDER BY (last_used_at > created_at AND last_used_at > now() - interval '5 minutes') DESC, last_used_at DESC, created_at DESC, id DESC OFFSET $2
     )`,
    [deviceId, keepId === undefined ? cap : cap - 1, keepId ?? null],
  );
  return res.rowCount ?? 0;
}

export async function countSessionsForAccount(db: Queryable, accountId: string): Promise<number> {
  const res = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM session WHERE account_id = $1", [accountId]);
  return Number(res.rows[0]!.n);
}
