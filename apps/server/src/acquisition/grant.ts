/**
 * The acquisition boundary (chunk 18, GUARDRAILS §3). EVERY unit instance that either
 * acquisition path creates is created by `grantUnit`, and `grantUnit` asks chunk 05's
 * `hasAccess` — the one access gate — immediately before the INSERT, inside the
 * transaction, under the account append lock. There is no other INSERT into
 * `unit_instance` in this directory (a test greps for it), so a hand-crafted request naming
 * a type the caravan has not reached — a locked node, another region's unit, a type nobody
 * has — cannot produce an instance by any path, however the request got here and whatever
 * Coin it offers. Filtering a menu or a price list is presentation; this is the check.
 *
 * Both paths grant a LEVEL-1 copy (merging up is chunk 16's job), caravan-scoped
 * (GUARDRAILS §5), with one `unit_acquired` event per instance.
 *
 * UNIT_INVENTORY_CAP is a storage guard only: counted under the account lock (which
 * serializes every acquisition and merge for the account) and generous enough never to bind
 * in practice. It is checked BEFORE any Coin moves so a refused grant costs nothing.
 *
 * Conventions: a caravan that is not the caller's is a 404, the same as one that does not
 * exist. A caravan id that is not a uuid is a 400 before any query. Acquisition is allowed
 * while the caravan is on a trip: the new instance lands in the town roster, not in the
 * trip-locked manifest (chunk 07), so it neither resupplies nor repairs anything mid-trip.
 */
import { TUNABLES, getUnitType, type LivingUnitType, type RegionId } from "@caravan/content";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import type { CaravanState, UnitInstanceRow } from "../db/types.js";
import type { JsonObject, LedgerEventDraft } from "../ledger/events.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { hasAccess, type AccessOwner } from "../unlocks/access.js";

/** "starting_roster": chunk 24 QA D1, every caravan's creation grant (startingRoster.ts). */
export type AcquisitionSource = "refugee" | "mercenary" | "starting_roster";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const notFound = (message: string): AppError => new AppError(404, "not_found", message);

/** The caravan id in the path, before it reaches a `uuid` column. Lowercased so retries match. */
export function normalizeCaravanId(caravanId: unknown): string {
  if (typeof caravanId !== "string" || !UUID.test(caravanId)) throw badRequest("invalid_caravan_id", "caravanId must be a uuid");
  return caravanId.toLowerCase();
}

/** A client-supplied idempotency key, if any: a uuid, lowercased. */
export function normalizeRequestId(requestId: unknown): string | undefined {
  if (requestId === undefined || requestId === null) return undefined;
  if (typeof requestId !== "string" || !UUID.test(requestId)) throw badRequest("invalid_request_id", "requestId, if given, must be a uuid");
  return requestId.toLowerCase();
}

/** A unit type id from a request body: a short string, nothing more is assumed about it yet. */
export function normalizeUnitTypeId(unitTypeId: unknown): string {
  if (typeof unitTypeId !== "string" || unitTypeId.length === 0 || unitTypeId.length > 100) {
    throw badRequest("invalid_unit_type", "unitTypeId must be a unit type id");
  }
  return unitTypeId;
}

/** The largest menu sequence a request may name: a Postgres `integer`, so it can be compared with a row. */
export const MAX_SEQUENCE = 2_147_483_647;

/**
 * A REQUIRED menu sequence field (`sequence` on claim, `fromSequence` on reroll and refresh)
 * from a request body: the menu the client is looking at, as GET /refugees reported it.
 * Required (chunk 18 QA S1) so a retry whose first attempt landed can never apply to a
 * later menu; bounded to 1..2147483647 (S3) so it is a safe integer and fits the column.
 */
export function normalizeSequence(value: unknown, name: string): number {
  if (value === undefined || value === null) {
    throw badRequest(`invalid_${name}`, `${name} is required: the sequence of the menu you are looking at, from GET .../refugees`);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SEQUENCE) {
    throw badRequest(`invalid_${name}`, `${name} must be an integer in 1..${MAX_SEQUENCE}`);
  }
  return value;
}

/** The body may be anything JSON (an array, a string, null); only an object's fields count. */
export function bodyObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export interface OwnedCaravan extends AccessOwner {
  /** Always read from the caravan row (chunk 05 QA S2 made it optional on AccessOwner). */
  readonly regionId: RegionId;
  readonly state: CaravanState;
}

/**
 * The caravan must be the caller's (else 404, same as not existing). With `lock`, FOR SHARE
 * so the row cannot change under an open acquisition transaction.
 */
export async function readOwnedCaravan(db: Queryable, accountId: string, caravanId: string, lock: boolean): Promise<OwnedCaravan> {
  const res = await db.query<{ region_id: RegionId; state: CaravanState }>(
    `SELECT region_id, state FROM caravan WHERE id = $1 AND account_id = $2${lock ? " FOR SHARE" : ""}`,
    [caravanId, accountId],
  );
  const row = res.rows[0];
  if (!row) throw notFound(`caravan ${caravanId} is not yours`);
  return { accountId, caravanId, regionId: row.region_id, state: row.state };
}

export interface InventoryStatus {
  count: number;
  cap: number;
  room: number;
  full: boolean;
}

export async function readInventory(db: Queryable, caravanId: string): Promise<InventoryStatus> {
  const res = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM unit_instance WHERE caravan_id = $1", [caravanId]);
  const count = Number(res.rows[0]!.n);
  const cap = TUNABLES.UNIT_INVENTORY_CAP;
  return { count, cap, room: Math.max(0, cap - count), full: count >= cap };
}

/**
 * The refusal every hand-crafted request gets, whatever it named: a locked node, another
 * region's unit, a type that exists for nobody. One code, because from the player's side
 * they are the same fact — the unlock web has not reached it.
 */
export function notUnlocked(typeId: string): AppError {
  return conflict("not_unlocked", `unit type '${typeId}' is not in this caravan's unlocked pool; the unlock web is the only access gate`);
}

/**
 * THE check. True only for a living type of the caravan's region whose node this caravan
 * has reached (chunk 05's `hasAccess`, read from the ledger). Call it inside the
 * transaction that acts on the answer.
 */
export async function assertUnlockedLivingType(db: Queryable, owner: AccessOwner, typeId: string): Promise<LivingUnitType> {
  const unit = getUnitType(typeId);
  if (!unit || unit.regionId !== owner.regionId) throw notUnlocked(typeId);
  if (!(await hasAccess(db, owner, typeId))) throw notUnlocked(typeId);
  return unit;
}

/** The `unit_acquired` payload. Integers only; what a retry gets back. */
export interface UnitAcquiredPayload extends JsonObject {
  unitTypeId: string;
  instanceId: string;
  mergeLevel: number;
  source: AcquisitionSource;
  coinCost: number;
}

export interface GrantedUnit {
  instance: UnitInstanceRow;
  unit: LivingUnitType;
  payload: UnitAcquiredPayload;
  /** The `unit_acquired` draft, for the caller to append under its causation id (alone or alongside a debit). */
  draft: LedgerEventDraft;
}

/**
 * Create one level-1 instance of `typeId` on the caravan, after the access check and the
 * inventory guard, and hand back the `unit_acquired` draft to append. Runs inside the
 * caller's transaction, which must hold the account append lock (every caller here does).
 * The caller appends the draft in the same transaction, so an instance without its event
 * cannot commit.
 */
export async function grantUnit(
  client: pg.PoolClient,
  owner: AccessOwner,
  typeId: string,
  source: AcquisitionSource,
  coinCost: number,
  extra: Record<string, string | number> = {},
): Promise<GrantedUnit> {
  if (!Number.isSafeInteger(coinCost) || coinCost < 0) throw new RangeError("coinCost must be a non-negative integer");
  const unit = await assertUnlockedLivingType(client, owner, typeId);
  const inventory = await readInventory(client, owner.caravanId);
  if (inventory.full) {
    throw conflict("inventory_full", `this caravan holds ${inventory.count} units; the storage cap is ${inventory.cap}`);
  }
  const ins = await client.query<UnitInstanceRow>(
    "INSERT INTO unit_instance (caravan_id, unit_type_id, merge_level) VALUES ($1, $2, $3) RETURNING *",
    [owner.caravanId, unit.id, TUNABLES.MERGE_LEVEL_MIN],
  );
  const instance = ins.rows[0]!;
  const payload: UnitAcquiredPayload = { ...extra, unitTypeId: unit.id, instanceId: instance.id, mergeLevel: instance.merge_level, source, coinCost };
  const draft: LedgerEventDraft = { type: "unit_acquired", accountId: owner.accountId, caravanId: owner.caravanId, payload };
  return { instance, unit, payload, draft };
}

/** What the UI shows for an offer or a price-list row. Presentation only. */
export interface UnitTypeSummary {
  unitTypeId: string;
  displayName: string;
  affinity: string;
  ability: { archetype: string; displayName: string };
}

export function summarizeUnit(unit: LivingUnitType): UnitTypeSummary {
  return { unitTypeId: unit.id, displayName: unit.displayName, affinity: unit.affinity, ability: { archetype: unit.ability.archetype, displayName: unit.ability.displayName } };
}
