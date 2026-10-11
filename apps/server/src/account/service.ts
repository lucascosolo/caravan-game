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
import { analyticsRecordsForExport } from "../analytics/export.js";
import { DELETE_CONFIRM_PHRASE, EXPORT_MAX_BYTES } from "./tunables.js";

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
export type ErasureReason = "player_request" | "guest_left" | "guest_replaced";

export async function eraseAccount(pool: pg.Pool, accountId: string, bearerToken: string, reason: ErasureReason = "player_request"): Promise<ErasureCounts> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(pool, async (client) => {
        const res = await client.query<{ counts: ErasureCounts }>("SELECT account_erase($1, $2, $3) AS counts", [accountId, bearerToken, reason]);
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

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** What a redacted id becomes: the export is this player's data, not the other participant's. */
export const EXPORT_OTHER_ID = "other_player";

/**
 * QA-30 D4: redaction by STRUCTURE, not by key name. Every UUID anywhere in the export — a whole
 * value, an object key, or inside a string such as a job id (`encounter:<trip>:1`) — is kept only
 * if it is on the allowlist of ids this account itself owns (its account, caravans, units ever
 * held, trips, manifests, party, devices, purchases, analytics id). Everything else becomes
 * "other_player": the other participant's trip, party, units and account alike.
 */
export function redactToOwnIds(v: unknown, own: ReadonlySet<string>): unknown {
  const fix = (s: string): string => s.replace(UUID_ANYWHERE, (m) => (own.has(m.toLowerCase()) ? m : EXPORT_OTHER_ID));
  if (typeof v === "string") return fix(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => redactToOwnIds(x, own));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [fix(k), redactToOwnIds(x, own)]));
  return v;
}

async function rows(db: Queryable, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  return (await db.query(sql, params)).rows as Record<string, unknown>[];
}

const UNIT_EVENT_TYPES = ["unit_acquired", "unit_merged", "unit_demerged_on_death", "unit_lost_on_wipe", "unit_retired"];

function collectUuids(v: unknown, into: Set<string>): void {
  if (typeof v === "string") for (const m of v.match(UUID_ANYWHERE) ?? []) into.add(m.toLowerCase());
  else if (Array.isArray(v)) for (const x of v) collectUuids(x, into);
  else if (v && typeof v === "object" && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) {
    collectUuids(k, into);
    collectUuids(x, into);
  }
}

/**
 * The account's data as JSON text (QA-30 D4: every table the account owns, plus summaries of
 * the fights it took part in), redacted to its own ids, refused above EXPORT_MAX_BYTES (413).
 */
export async function exportAccount(db: Queryable, accountId: string, maxBytes: number = EXPORT_MAX_BYTES): Promise<string> {
  const account = await findAccountById(db, accountId);
  if (!account) throw new AppError(404, "no_account", "account not found");
  const caravans = await rows(db, "SELECT * FROM caravan WHERE account_id = $1 ORDER BY created_at, id", [accountId]);
  const caravanIds = caravans.map((c) => c["id"] as string);
  const own = new Set<string>([accountId, ...caravanIds]);
  const ledger = await rows(db, "SELECT seq, event_type, caravan_id, causation_id, causation_seq, resolver_version, payload, occurred_at FROM ledger_event WHERE account_id = $1 ORDER BY seq", [accountId]);
  // Units this account ever held: every id in its own unit events is one of its own instances.
  for (const e of ledger) if (UNIT_EVENT_TYPES.includes(e["event_type"] as string)) collectUuids(e["payload"], own);

  const perCaravan = [];
  for (const c of caravans) {
    const cid = c["id"] as string;
    const units = await rows(db, "SELECT id, unit_type_id, merge_level, created_at FROM unit_instance WHERE caravan_id = $1 ORDER BY created_at, id", [cid]);
    const trips = await rows(db, "SELECT * FROM trip WHERE caravan_id = $1 ORDER BY started_at, id", [cid]);
    const manifests = await rows(db, "SELECT * FROM wagon_manifest WHERE caravan_id = $1 ORDER BY created_at, id", [cid]);
    for (const u of units) own.add(u["id"] as string);
    for (const t of trips) own.add(t["id"] as string);
    for (const m of manifests) {
      own.add(m["id"] as string);
      // A manifest names only this caravan's own units (packed from its roster).
      collectUuids(m["packed"], own);
    }
    perCaravan.push({
      ...c,
      poolProgress: await rows(db, "SELECT pool, reputation, ladder_level, ladder_points, unlock_points_granted, unlock_points_spent, created_at, updated_at FROM pool_progress WHERE caravan_id = $1", [cid]),
      units,
      manifests,
      formations: await rows(db, "SELECT f.* FROM wagon_formation f JOIN wagon_manifest m ON m.id = f.manifest_id WHERE m.caravan_id = $1 ORDER BY m.created_at, f.encounter_index", [cid]),
      refugeeMenus: await rows(db, "SELECT * FROM refugee_menu WHERE caravan_id = $1 ORDER BY sequence", [cid]),
      trips,
      tripEncounters: await rows(db, "SELECT te.* FROM trip_encounter te JOIN trip t ON t.id = te.trip_id WHERE t.caravan_id = $1 ORDER BY te.settled_at, te.trip_id, te.encounter_index", [cid]),
      tripMenus: await rows(db, "SELECT ec.* FROM encounter_candidates ec JOIN trip t ON t.id = ec.trip_id WHERE t.caravan_id = $1 ORDER BY ec.created_at, ec.trip_id, ec.encounter_index, ec.search_seq", [cid]),
    });
  }
  const parties = await rows(db, "SELECT * FROM standing_party WHERE account_id = $1 ORDER BY slot", [accountId]);
  for (const p of parties) own.add(p["id"] as string);
  const devices = (await listDevices(db, accountId)).map((d) => ({ id: d.id, label: d.label, createdAt: d.created_at, lastSeenAt: d.last_seen_at, expiresAt: d.expires_at }));
  for (const d of devices) own.add(d.id);
  const store = await storeRecordsForExport(db, accountId);
  for (const p of store.purchases) own.add((p as { id: string }).id);
  const analytics = await analyticsRecordsForExport(db, accountId);
  if (analytics.analytics) own.add((analytics.analytics as { analytics_id: string }).analytics_id);

  // The fights it took part in, either side: the stored outcome and the replay's record (its log
  // stays on the server; the other participant's side of it is not this player's to export).
  const encounters = await rows(
    db,
    `SELECT j.id AS job_id, CASE WHEN j.account_id = $1 THEN 'caravan' ELSE 'party_owner' END AS role, j.status, j.created_at, j.completed_at,
            j.result->'outcome' AS outcome,
            l.resolver_version, l.log_format, l.raw_bytes, l.stored_bytes, l.log_sha256, l.created_at AS replay_created_at, (l.job_id IS NOT NULL) AS replay_stored
       FROM resolution_job j LEFT JOIN encounter_log l ON l.job_id = j.id
      WHERE j.kind = 'encounter_resolution' AND (j.account_id = $1 OR j.input->>'partyOwnerAccountId' = $1::text)
      ORDER BY j.created_at, j.id`,
    [accountId],
  );

  const body = {
    format: "caravan-vaults-account-export",
    version: 2,
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
    standingParties: parties,
    onboarding: (await rows(db, "SELECT step, skipped_at, completed_at, updated_at FROM account_onboarding WHERE account_id = $1", [accountId]))[0] ?? null,
    inboxPreferences: await rows(db, "SELECT category, enabled FROM inbox_preference WHERE account_id = $1 ORDER BY category", [accountId]),
    inboxRead: await rows(db, "SELECT item_key, version, read_at FROM inbox_read WHERE account_id = $1 ORDER BY item_key", [accountId]),
    tripCap: (await rows(db, "SELECT * FROM trip_cap WHERE account_id = $1", [accountId]))[0] ?? null,
    tripCapUses: await rows(db, "SELECT * FROM trip_cap_use WHERE account_id = $1 ORDER BY trip_id", [accountId]),
    ...store,
    ...analytics,
    devices,
    caravans: perCaravan,
    encounters,
    ledger,
  };
  const text = JSON.stringify(redactToOwnIds(body, own));
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new AppError(413, "export_too_large", `this account's export is larger than ${maxBytes} bytes; ask an operator for it`);
  }
  return text;
}
