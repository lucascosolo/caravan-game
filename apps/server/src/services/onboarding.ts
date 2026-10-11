/**
 * Registration: one transaction creates the account-level rows (account, home town,
 * standing party, trap + siege progress, chunk 24's onboarding marker) and the first caravan with its region and its
 * caravan-level living-unit progress.
 */
import type pg from "pg";
import { CARAVAN_NAME_MAX, CARAVAN_NAME_MIN, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from "../config.js";
import { withTransaction } from "../db/pool.js";
import type { AccountRow, CaravanRow } from "../db/types.js";
import { hashPassword } from "../auth/password.js";
import { createAccount, createHomeTown, createStandingParty } from "../repo/accounts.js";
import { ACCOUNT_POOLS, createAccountPoolProgress } from "../repo/poolProgress.js";
import { SYSTEM_USERNAME_PREFIX, hasSystemUsernamePrefix } from "../matchmaking/reservedUsername.js";
import { enrollOnboarding } from "../onboarding/service.js";
import { createCaravanForAccount } from "./caravans.js";
import { badRequest, conflict } from "./errors.js";

const USERNAME_RE = /^[a-z0-9_]+$/;
/**
 * Chunk 25 (chunk 14 QA N2): the authored system accounts' handle prefix; no player may
 * register under it. A LITERAL prefix, tested by the same predicate the seed uses (chunk 25
 * QA B1: matchmaking/reservedUsername.ts) — never as a LIKE pattern.
 */
export const RESERVED_USERNAME_PREFIX = SYSTEM_USERNAME_PREFIX;

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

/** Trimmed, 1..CARAVAN_NAME_MAX characters, no control characters. */
export function normalizeCaravanName(raw: string): string {
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (name.length < CARAVAN_NAME_MIN || name.length > CARAVAN_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw badRequest(
      "invalid_caravan_name",
      `caravanName must be ${CARAVAN_NAME_MIN}-${CARAVAN_NAME_MAX} characters after trimming, with no control characters`,
    );
  }
  return name;
}

export async function registerAccount(
  pool: pg.Pool,
  input: { username: string; password: string; regionId: string; caravanName?: string },
): Promise<{ account: AccountRow; caravan: CaravanRow }> {
  const username = normalizeUsername(input.username);
  if (hasSystemUsernamePrefix(username)) {
    throw badRequest("reserved_username", `usernames starting with '${RESERVED_USERNAME_PREFIX}' are reserved`);
  }
  if (
    typeof input.password !== "string" ||
    input.password.length < PASSWORD_MIN ||
    input.password.length > PASSWORD_MAX
  ) {
    throw badRequest("invalid_password", `password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  }
  const caravanName = input.caravanName !== undefined ? normalizeCaravanName(input.caravanName) : undefined;
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
    // Chunk 24: a new player starts the first-session guide (account-level, PHASE-2 §24).
    await enrollOnboarding(client, account.id);
    // First (and, in v1, only) caravan.
    const caravanInput: Parameters<typeof createCaravanForAccount>[1] = {
      accountId: account.id,
      regionId: input.regionId,
    };
    if (caravanName !== undefined) caravanInput.name = caravanName;
    const caravan = await createCaravanForAccount(client, caravanInput);
    return { account, caravan };
  });
}
