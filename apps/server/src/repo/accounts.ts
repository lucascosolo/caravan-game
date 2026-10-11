import { TUNABLES } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import type { AccountRow } from "../db/types.js";

export async function createAccount(
  db: Queryable,
  input: { username: string; passwordHash: string },
): Promise<AccountRow> {
  const res = await db.query<AccountRow>(
    `INSERT INTO account (username, password_hash, coin_storage_cap)
     VALUES ($1, $2, $3) RETURNING *`,
    [input.username, input.passwordHash, TUNABLES.COIN_STORAGE_CAP],
  );
  return res.rows[0]!;
}

export async function findAccountById(db: Queryable, id: string): Promise<AccountRow | null> {
  const res = await db.query<AccountRow>("SELECT * FROM account WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

export async function findAccountByUsername(db: Queryable, username: string): Promise<AccountRow | null> {
  const res = await db.query<AccountRow>("SELECT * FROM account WHERE username = $1", [username]);
  return res.rows[0] ?? null;
}

/** Account-level hub rows. One each per account; created at registration. */
export async function createHomeTown(db: Queryable, accountId: string): Promise<void> {
  await db.query("INSERT INTO home_town (account_id) VALUES ($1)", [accountId]);
}

export async function createStandingParty(db: Queryable, accountId: string): Promise<void> {
  await db.query("INSERT INTO standing_party (account_id) VALUES ($1)", [accountId]);
}
