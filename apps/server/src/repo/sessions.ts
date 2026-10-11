import type { Queryable } from "../db/pool.js";
import type { SessionRow } from "../db/types.js";

export async function insertSession(
  db: Queryable,
  input: { accountId: string; tokenHash: string; expiresAt: Date },
): Promise<SessionRow> {
  const res = await db.query<SessionRow>(
    `INSERT INTO session (account_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING *`,
    [input.accountId, input.tokenHash, input.expiresAt],
  );
  return res.rows[0]!;
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
export async function evictSessionsBeyondCap(db: Queryable, accountId: string, cap: number): Promise<number> {
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`session cap must be a positive integer, got ${cap}`);
  const res = await db.query(
    `DELETE FROM session WHERE id IN (
       SELECT id FROM session WHERE account_id = $1
       ORDER BY created_at DESC, id DESC OFFSET $2
     )`,
    [accountId, cap],
  );
  return res.rowCount ?? 0;
}

export async function countSessionsForAccount(db: Queryable, accountId: string): Promise<number> {
  const res = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM session WHERE account_id = $1", [accountId]);
  return Number(res.rows[0]!.n);
}
