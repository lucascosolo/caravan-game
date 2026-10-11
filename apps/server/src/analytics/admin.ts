/**
 * Chunk 32: the admin flag (migration 018 `account_admin`). The server only READS it: the
 * app role holds SELECT and nothing else on the table (db/roles.sql), so no player route can
 * grant it. `grantAdmin` / `revokeAdmin` are for the operator CLI (src/admin.ts), which
 * connects as the schema OWNER; called over the app role they fail with a privilege error.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Queryable } from "../db/pool.js";
import { authenticate } from "../auth/sessions.js";
import { AppError } from "../services/errors.js";

export async function isAdmin(db: Queryable, accountId: string): Promise<boolean> {
  const res = await db.query("SELECT 1 FROM account_admin WHERE account_id = $1", [accountId]);
  return (res.rowCount ?? 0) > 0;
}

/** The answer every non-admin gets from /admin/*: the same 404 an unknown route gives, so the surface is not advertised. */
export const ADMIN_NOT_FOUND = new AppError(404, "not_found", "not found");

/**
 * Fastify preHandler for /admin/*: a missing or bad token, a non-admin account and an admin
 * all look the same from outside until the last one gets a body. Never 401/403.
 */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const ctx = await authenticate(req.server.db, req.headers.authorization);
  if (!ctx || !(await isAdmin(req.server.db, ctx.account.id))) throw ADMIN_NOT_FOUND;
  req.auth = ctx;
}

const LABEL = /^[A-Za-z0-9 ._@-]{1,64}$/;

/** Owner connection only. Idempotent. Refuses system accounts (they cannot log in anyway). */
export async function grantAdmin(db: Queryable, username: string, grantedBy: string): Promise<{ accountId: string; granted: boolean }> {
  if (!LABEL.test(grantedBy)) throw new Error("--by must be 1..64 of [A-Za-z0-9 ._@-]");
  const acc = await db.query<{ id: string; is_system: boolean }>("SELECT id, is_system FROM account WHERE username = $1", [username]);
  const row = acc.rows[0];
  if (!row) throw new Error(`no account named '${username}'`);
  if (row.is_system) throw new Error(`'${username}' is a system account`);
  const res = await db.query("INSERT INTO account_admin (account_id, granted_by) VALUES ($1, $2) ON CONFLICT (account_id) DO NOTHING", [row.id, grantedBy]);
  return { accountId: row.id, granted: (res.rowCount ?? 0) > 0 };
}

export async function revokeAdmin(db: Queryable, username: string): Promise<{ revoked: boolean }> {
  const res = await db.query("DELETE FROM account_admin WHERE account_id = (SELECT id FROM account WHERE username = $1)", [username]);
  return { revoked: (res.rowCount ?? 0) > 0 };
}

export async function listAdmins(db: Queryable): Promise<{ username: string; grantedBy: string; grantedAt: string }[]> {
  const res = await db.query<{ username: string; granted_by: string; granted_at: Date }>(
    "SELECT a.username, x.granted_by, x.granted_at FROM account_admin x JOIN account a ON a.id = x.account_id ORDER BY x.granted_at, a.username",
  );
  return res.rows.map((r) => ({ username: r.username, grantedBy: r.granted_by, grantedAt: r.granted_at.toISOString() }));
}
