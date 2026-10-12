/**
 * Chunk 32 operator CLI: grant, revoke or list the admin flag that opens /admin/*.
 *
 *   tsx src/admin.ts grant <username> [--by <label>]
 *   tsx src/admin.ts revoke <username>
 *   tsx src/admin.ts list
 *
 * (`pnpm --filter @caravan/server admin …`; built: `node apps/server/dist/admin.js …`.)
 *
 * Connects with MIGRATE_DATABASE_URL — the schema OWNER — because the server's own role
 * (caravan_app) can only read account_admin (db/roles.sql). There is no HTTP route that
 * writes it, for players or for admins.
 */
import { assertProductionDatabaseUrl, loadDotEnv, migrateDatabaseUrl } from "./config.js";
import { createPool } from "./db/pool.js";
import { grantAdmin, listAdmins, revokeAdmin } from "./analytics/admin.js";

async function main(): Promise<void> {
  const [cmd, username, ...rest] = process.argv.slice(2);
  // Final review N2 / S2: the repo's .env, then no repo-default password in production.
  loadDotEnv();
  assertProductionDatabaseUrl(process.env, process.env["MIGRATE_DATABASE_URL"] ?? process.env["DATABASE_URL"], "MIGRATE_DATABASE_URL");
  const pool = createPool(migrateDatabaseUrl());
  try {
    if (cmd === "grant" && username) {
      const byIdx = rest.indexOf("--by");
      const by = byIdx >= 0 ? rest[byIdx + 1] ?? "" : (process.env["USER"] ?? "operator");
      const r = await grantAdmin(pool, username, by);
      console.log(r.granted ? `granted admin to '${username}' (${r.accountId})` : `'${username}' is already an admin`);
    } else if (cmd === "revoke" && username) {
      const r = await revokeAdmin(pool, username);
      console.log(r.revoked ? `revoked admin from '${username}'` : `'${username}' was not an admin`);
    } else if (cmd === "list") {
      for (const a of await listAdmins(pool)) console.log(`${a.username}\tby ${a.grantedBy}\t${a.grantedAt}`);
    } else {
      console.error("usage: admin grant <username> [--by <label>] | revoke <username> | list");
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
