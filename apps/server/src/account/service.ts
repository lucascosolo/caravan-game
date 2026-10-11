/**
 * Chunk 30: the account lifecycle — guest creation, linking, the device list, the JSON export
 * and deletion (PHASE-2 §30, play-test cut: username + password is the only thing a guest
 * links to; Sign in with Apple / Google waits for chunk 34).
 *
 *   Guest-first. A guest is an ordinary account row with no username or password, created
 *   with the same hub rows and first caravan a registration makes (services/onboarding.ts
 *   createAccountHub), so the whole chunk 24 tutorial plays as a guest. Linking sets the
 *   username and password on THAT row: the account id never changes and nothing is migrated.
 *   The region stays what the caravan was created with (one-time per caravan; there is no
 *   account-level path to change it).
 *
 *   Deletion is account_erase (migration 020, SECURITY DEFINER): the account and everything
 *   only it owns are deleted; what it shares with other players (replays, their ledgers, their
 *   trips and menus) is anonymized to the tombstone. See the migration's header.
 */
import type pg from "pg";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { withTransaction, type Queryable } from "../db/pool.js";
import type { AccountRow, CaravanRow } from "../db/types.js";
import { createGuestAccount, findAccountById } from "../repo/accounts.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { createAccountHub, normalizeCaravanName, validateCredentials } from "../services/onboarding.js";
import { listDevices, type DeviceRow } from "./device.js";
import { storeRecordsForExport } from "../store/export.js";
import { DELETE_CONFIRM_PHRASE } from "./tunables.js";

export async function createGuest(pool: pg.Pool, input: { regionId: string; caravanName?: string }): Promise<{ account: AccountRow; caravan: CaravanRow }> {
  const caravanName = input.caravanName !== undefined ? normalizeCaravanName(input.caravanName) : undefined;
  return withTransaction(pool, async (client) => {
    const account = await createGuestAccount(client);
    const caravan = await createAccountHub(client, account.id, input.regionId, caravanName);
    return { account, caravan };
  });
}

/** Guest → linked: the same row gains a username and a password, once. */
export async function linkAccount(pool: pg.Pool, accountId: string, rawUsername: string, password: unknown): Promise<AccountRow> {
  const creds = validateCredentials(rawUsername, password);
  const hash = await hashPassword(creds.password);
  try {
    const res = await pool.query<AccountRow>(
      "UPDATE account SET username = $2, password_hash = $3 WHERE id = $1 AND username IS NULL AND NOT is_system RETURNING *",
      [accountId, creds.username, hash],
    );
    if (res.rows[0]) return res.rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("username_taken", `username '${creds.username}' is taken`);
    throw err;
  }
  throw conflict("already_linked", "this account already has a username and password");
}

export interface DeviceView {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export function deviceView(d: DeviceRow, currentDeviceId: string | null): DeviceView {
  return { id: d.id, label: d.label, createdAt: d.created_at.toISOString(), lastSeenAt: d.last_seen_at.toISOString(), expiresAt: d.expires_at.toISOString(), current: d.id === currentDeviceId };
}

export async function deviceViews(db: Queryable, accountId: string, currentDeviceId: string | null): Promise<DeviceView[]> {
  return (await listDevices(db, accountId)).map((d) => deviceView(d, currentDeviceId));
}

/** What the delete request must carry: the typed phrase always, and the password once one exists. */
export function deletionTerms(account: AccountRow): { confirmPhrase: string; requiresPassword: boolean } {
  return { confirmPhrase: DELETE_CONFIRM_PHRASE, requiresPassword: account.password_hash !== null };
}

export async function checkDeletionRequest(account: AccountRow, body: { confirm?: unknown; password?: unknown }): Promise<void> {
  if (body.confirm !== DELETE_CONFIRM_PHRASE) throw badRequest("confirm_required", `type '${DELETE_CONFIRM_PHRASE}' to delete this account`);
  if (account.password_hash !== null) {
    if (typeof body.password !== "string" || body.password.length > 128) throw new AppError(403, "password_required", "enter your password to delete this account");
    if (!(await verifyPassword(body.password, account.password_hash))) throw new AppError(403, "wrong_password", "that password is not this account's");
  }
}

export type ErasureCounts = Record<string, number>;

/** Erase: one transaction through account_erase, retried on a deadlock / serialization failure (a settle racing it). */
export async function eraseAccount(pool: pg.Pool, accountId: string, bearerToken: string): Promise<ErasureCounts> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(pool, async (client) => {
        const res = await client.query<{ counts: ErasureCounts }>("SELECT account_erase($1, $2) AS counts", [accountId, bearerToken]);
        return res.rows[0]!.counts;
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === "40P01" || code === "40001") && attempt < 3) continue;
      if (code === "P0002") throw new AppError(404, "no_account", "account not found");
      if (code === "42501") throw new AppError(401, "unauthorized", "this session cannot delete the account");
      throw err;
    }
  }
}

// ── export ─────────────────────────────────────────────────────────────────────────────

const OTHER_ID_KEY = /(^|_)(account_id|caravan_id)$|(AccountId|CaravanId)$/;

/**
 * The export is this player's data, not the other participant's: an account or caravan id that
 * is not this player's own (the party owner a caravan met, the caravan a party struck) is
 * replaced by "other_player". Everything else is as stored.
 */
function redactOthers(v: unknown, own: ReadonlySet<string>, key = ""): unknown {
  if (typeof v === "string") return OTHER_ID_KEY.test(key) && !own.has(v) ? "other_player" : v;
  if (Array.isArray(v)) return v.map((x) => redactOthers(x, own));
  if (v && typeof v === "object" && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactOthers(x, own, k)]));
  return v;
}

async function rows(db: Queryable, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  return (await db.query(sql, params)).rows as Record<string, unknown>[];
}

export async function exportAccount(db: Queryable, accountId: string): Promise<Record<string, unknown>> {
  const account = await findAccountById(db, accountId);
  if (!account) throw new AppError(404, "no_account", "account not found");
  const caravans = await rows(db, "SELECT * FROM caravan WHERE account_id = $1 ORDER BY created_at, id", [accountId]);
  const caravanIds = caravans.map((c) => c["id"] as string);
  const own = new Set<string>([accountId, ...caravanIds]);
  const perCaravan = await Promise.all(
    caravans.map(async (c) => ({
      ...c,
      poolProgress: await rows(db, "SELECT pool, reputation, ladder_level, ladder_points, unlock_points_granted, unlock_points_spent, created_at, updated_at FROM pool_progress WHERE caravan_id = $1", [c["id"]]),
      units: await rows(db, "SELECT id, unit_type_id, merge_level, created_at FROM unit_instance WHERE caravan_id = $1 ORDER BY created_at, id", [c["id"]]),
      trips: await rows(db, "SELECT * FROM trip WHERE caravan_id = $1 ORDER BY started_at, id", [c["id"]]),
      tripEncounters: await rows(db, "SELECT te.* FROM trip_encounter te JOIN trip t ON t.id = te.trip_id WHERE t.caravan_id = $1 ORDER BY te.settled_at, te.trip_id, te.encounter_index", [c["id"]]),
    })),
  );
  const encounters = await rows(
    db,
    `SELECT id AS job_id, CASE WHEN account_id = $1 THEN 'caravan' ELSE 'party_owner' END AS role, status, created_at, completed_at, result->'outcome'->>'kind' AS outcome_kind
       FROM resolution_job
      WHERE kind = 'encounter_resolution' AND (account_id = $1 OR input->>'partyOwnerAccountId' = $1::text)
      ORDER BY created_at, id`,
    [accountId],
  );
  const body = {
    format: "caravan-vaults-account-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    account: {
      id: account.id,
      username: account.username,
      guest: account.username === null,
      createdAt: account.created_at.toISOString(),
      linkedAt: account.linked_at ? account.linked_at.toISOString() : null,
      coinBalance: account.coin_balance,
      coinStorageCap: account.coin_storage_cap,
    },
    accountPoolProgress: await rows(db, "SELECT pool, reputation, ladder_level, ladder_points, unlock_points_granted, unlock_points_spent, created_at, updated_at FROM pool_progress WHERE account_id = $1", [accountId]),
    homeTown: (await rows(db, "SELECT * FROM home_town WHERE account_id = $1", [accountId]))[0] ?? null,
    standingParties: await rows(db, "SELECT * FROM standing_party WHERE account_id = $1 ORDER BY slot", [accountId]),
    onboarding: (await rows(db, "SELECT step, skipped_at, completed_at, updated_at FROM account_onboarding WHERE account_id = $1", [accountId]))[0] ?? null,
    ...(await storeRecordsForExport(db, accountId)),
    inboxPreferences: await rows(db, "SELECT category, enabled FROM inbox_preference WHERE account_id = $1 ORDER BY category", [accountId]),
    devices: (await listDevices(db, accountId)).map((d) => ({ id: d.id, label: d.label, createdAt: d.created_at, lastSeenAt: d.last_seen_at, expiresAt: d.expires_at })),
    caravans: perCaravan,
    encounters,
    ledger: await rows(db, "SELECT seq, event_type, caravan_id, causation_id, causation_seq, resolver_version, payload, occurred_at FROM ledger_event WHERE account_id = $1 ORDER BY seq", [accountId]),
  };
  return redactOthers(body, own) as Record<string, unknown>;
}
