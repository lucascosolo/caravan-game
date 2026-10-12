/**
 * Final review N7. PostgreSQL lets any login role `ALTER ROLE <itself> SET …`, and that setting
 * then applies to every later connection of the role (a `statement_timeout = 1` would take the
 * server down; a `search_path` would change what unqualified names mean). The guards do not
 * depend on it — every function pins its search_path — but the server should not run with a
 * setting nobody chose. Two defences:
 *
 *   1. createPool pins `search_path` on every connection it opens (db/pool.ts), so a role-level
 *      search_path never reaches the server's queries;
 *   2. at boot, index.ts reads this role's role-level settings (pg_db_role_setting, readable by
 *      any role) and refuses to start under NODE_ENV=production when there are any.
 */
import type { Queryable } from "./pool.js";

export async function checkRoleSettings(db: Queryable): Promise<string[]> {
  const res = await db.query<{ setting: string; scope: string }>(
    `SELECT unnest(s.setconfig) AS setting,
            CASE WHEN s.setdatabase = 0 THEN 'every database' ELSE 'this database' END AS scope
       FROM pg_db_role_setting s
      WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))`,
  );
  return res.rows.map((r) => `${r.setting} (${r.scope})`);
}
