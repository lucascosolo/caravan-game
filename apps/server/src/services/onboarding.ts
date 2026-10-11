/**
 * Registration: one transaction creates the account-level rows (account, home town,
 * standing party, trap + siege progress) and the first caravan with its region and its
 * caravan-level living-unit progress.
 */
import type pg from "pg";
import { PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from "../config.js";
import { withTransaction } from "../db/pool.js";
import type { AccountRow, CaravanRow } from "../db/types.js";
import { hashPassword } from "../auth/password.js";
import { createAccount, createHomeTown, createStandingParty } from "../repo/accounts.js";
import { ACCOUNT_POOLS, createAccountPoolProgress } from "../repo/poolProgress.js";
import { createCaravanForAccount } from "./caravans.js";
import { badRequest, conflict } from "./errors.js";

const USERNAME_RE = /^[a-z0-9_]+$/;

export function normalizeUsername(raw: string): string {
  const username = raw.trim().toLowerCase();
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX || !USERNAME_RE.test(username)) {
    throw badRequest(
      "invalid_username",
      `username must be ${USERNAME_MIN}-${USERNAME_MAX} characters of a-z, 0-9 or _`,
    );
  }
  return username;
}

export async function registerAccount(
  pool: pg.Pool,
  input: { username: string; password: string; regionId: string; caravanName?: string },
): Promise<{ account: AccountRow; caravan: CaravanRow }> {
  const username = normalizeUsername(input.username);
  if (typeof input.password !== "string" || input.password.length < PASSWORD_MIN) {
    throw badRequest("invalid_password", `password must be at least ${PASSWORD_MIN} characters`);
  }
  const passwordHash = await hashPassword(input.password);

  return withTransaction(pool, async (client) => {
    let account: AccountRow;
    try {
      account = await createAccount(client, { username, passwordHash });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw conflict("username_taken", `username '${username}' is taken`);
      }
      throw err;
    }
    // Account-level hub rows.
    await createHomeTown(client, account.id);
    await createStandingParty(client, account.id);
    for (const pool of ACCOUNT_POOLS) {
      await createAccountPoolProgress(client, account.id, pool);
    }
    // First (and, in v1, only) caravan.
    const caravanInput: Parameters<typeof createCaravanForAccount>[1] = {
      accountId: account.id,
      regionId: input.regionId,
    };
    if (input.caravanName !== undefined) caravanInput.name = input.caravanName;
    const caravan = await createCaravanForAccount(client, caravanInput);
    return { account, caravan };
  });
}
