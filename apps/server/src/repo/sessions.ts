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
