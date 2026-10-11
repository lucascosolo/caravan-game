/**
 * The trip cap (chunk 15): TRIPS_PER_HOUR_CAP uses stored, one regenerating every
 * TRIP_CAP_REGEN_MS, consumed once at trip START however many encounters the trip runs.
 *
 * Stored as ONE timestamp per account — the GCRA "theoretical arrival time" `tat` — and
 * computed lazily on read; there is no background tick and no counter to drift:
 *
 *   available(t) = CAP − ceil(max(0, tat − t) / REGEN)          (0 … CAP)
 *   consume at t: tat := max(tat, t) + REGEN                    (only if available(t) ≥ 1)
 *
 * A fresh account (no row, tat = 0) has CAP available. Three starts at t leave tat = t + 3R
 * and 0 available; one use returns at t + R, all of them at t + 3R. Idle time beyond a full
 * bucket is not banked (max(tat, t)), so the cap can never hold more than CAP.
 *
 * ACCOUNT-level (a player's budget; a second caravan must never multiply it). Never
 * purchasable: nothing here reads Coin, purchases or entitlements, and the DB refuses any
 * decrease of `tat` (no refund path). The clock is the caller's `nowMs` (injectable); the
 * routes pass the wall clock. It decides only WHEN a trip may start, never an outcome.
 */
import { TUNABLES } from "@caravan/content";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import { AppError } from "../services/errors.js";

export const TRIPS_PER_HOUR_CAP: number = TUNABLES.TRIPS_PER_HOUR_CAP;
export const TRIP_CAP_REGEN_MS: number = TUNABLES.TRIP_CAP_REGEN_MS;

export interface TripCapView {
  /** Trip starts available right now. */
  available: number;
  /** Most that can be stored. */
  cap: number;
  regenMs: number;
  /** When the next use returns (null when full). */
  nextRegenAtMs: number | null;
  /** When the cap is full again (null when full). */
  fullAtMs: number | null;
  /** Fixed: the cap is time-gated only. */
  gate: "time";
}

function assertMs(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative safe integer, got ${String(v)}`);
}

/** PURE. Uses available at `nowMs` for a stored `tatMs`. */
export function capAvailable(tatMs: number, nowMs: number): number {
  assertMs("tatMs", tatMs);
  assertMs("nowMs", nowMs);
  const owed = Math.max(0, tatMs - nowMs);
  const used = Math.ceil(owed / TRIP_CAP_REGEN_MS); // integers in, integer out (exact for safe ints)
  return Math.max(0, TRIPS_PER_HOUR_CAP - used);
}

/** PURE. The full view at `nowMs`. */
export function capView(tatMs: number, nowMs: number): TripCapView {
  const available = capAvailable(tatMs, nowMs);
  const full = available >= TRIPS_PER_HOUR_CAP;
  return {
    available,
    cap: TRIPS_PER_HOUR_CAP,
    regenMs: TRIP_CAP_REGEN_MS,
    // The next use returns when `owed` drops to the next lower multiple of REGEN.
    nextRegenAtMs: full ? null : tatMs - (TRIPS_PER_HOUR_CAP - available - 1) * TRIP_CAP_REGEN_MS,
    fullAtMs: full ? null : tatMs,
    gate: "time",
  };
}

/** PURE. The stored timestamp after one start at `nowMs`. Throws if nothing is available. */
export function capConsume(tatMs: number, nowMs: number): number {
  if (capAvailable(tatMs, nowMs) < 1) throw new RangeError("no trip-cap use available");
  return Math.max(tatMs, nowMs) + TRIP_CAP_REGEN_MS;
}

export class TripCapExhaustedError extends AppError {
  constructor(
    public readonly cap: TripCapView,
    public readonly retryAfterSeconds: number,
  ) {
    super(409, "trip_cap_exhausted", `no trip starts left; the next one returns in ${retryAfterSeconds} s`);
    this.name = "TripCapExhaustedError";
  }
}

export async function readTripCapTat(db: Queryable, accountId: string, forUpdate = false): Promise<number> {
  const res = await db.query<{ tat_ms: number }>(`SELECT tat_ms FROM trip_cap WHERE account_id = $1${forUpdate ? " FOR UPDATE" : ""}`, [accountId]);
  return res.rows[0]?.tat_ms ?? 0;
}

export async function readTripCap(db: Queryable, accountId: string, nowMs: number): Promise<TripCapView> {
  return capView(await readTripCapTat(db, accountId), nowMs);
}

/**
 * Consume one use inside the caller's transaction. The row is created on first use and
 * locked FOR UPDATE, so two concurrent starts on one account serialize here and each sees
 * the other's consumption. Returns the cap before and after.
 */
export async function consumeTripCap(client: pg.PoolClient, accountId: string, nowMs: number): Promise<{ before: TripCapView; after: TripCapView; tatMs: number }> {
  await client.query("INSERT INTO trip_cap (account_id, tat_ms) VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING", [accountId]);
  const tat = await readTripCapTat(client, accountId, true);
  const before = capView(tat, nowMs);
  if (before.available < 1) {
    throw new TripCapExhaustedError(before, Math.ceil(((before.nextRegenAtMs ?? nowMs) - nowMs) / 1000));
  }
  const next = capConsume(tat, nowMs);
  await client.query("UPDATE trip_cap SET tat_ms = $2 WHERE account_id = $1", [accountId, next]);
  return { before, after: capView(next, nowMs), tatMs: next };
}
