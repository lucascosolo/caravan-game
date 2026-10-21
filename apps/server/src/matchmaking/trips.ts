/**
 * The trip row (migration 009) — the SEAM chunk 15 builds the trip loop on. Chunk 14 needs
 * a trip id to seed candidate menus from and to key encounter candidates by; chunk 15 owns
 * when a trip starts (trip cap, caravan.state) and ends (bank / overrun / stalemate). Until
 * then these two functions are the only writers and tests call them directly.
 *
 * CARAVAN-level (GUARDRAILS §5). No geography, no route, no travel timer (chunk 15 brief).
 */
import { BATTLEFIELD_VERSION } from "@caravan/resolver";
import type pg from "pg";
import { findOpenManifest } from "../circle/repo.js";
import type { Queryable } from "../db/pool.js";
import { AppError, conflict } from "../services/errors.js";

export interface TripRow {
  id: string;
  caravan_id: string;
  manifest_id: string;
  started_at: Date;
  ended_at: Date | null;
  /** Chunk 50 (migration 031): the battlefield geometry the trip rode out under; immutable. */
  battlefield_version: number;
  /** Chunk 15 (migration 012): how the trip ended. Null while open, and for a bare endTrip(). */
  end_reason: TripEndReason | null;
}

export type TripEndReason = "banked" | "overrun" | "voided";

/**
 * Open a trip on the caravan's open manifest. Chunk 15 wraps this with the trip cap and the
 * caravan state change; here it only refuses a caravan with nothing packed or already out.
 */
export async function createTrip(client: pg.PoolClient, caravanId: string): Promise<TripRow> {
  await client.query("SELECT id FROM caravan WHERE id = $1 FOR UPDATE", [caravanId]);
  const manifest = await findOpenManifest(client, caravanId);
  if (!manifest) throw new AppError(404, "no_open_manifest", "this caravan is in town with nothing packed");
  if (await findOpenTrip(client, caravanId)) throw conflict("trip_open", "this caravan is already on a trip");
  const res = await client.query<TripRow>("INSERT INTO trip (caravan_id, manifest_id, battlefield_version) VALUES ($1, $2, $3) RETURNING *", [caravanId, manifest.id, BATTLEFIELD_VERSION]);
  return res.rows[0]!;
}

export async function findOpenTrip(db: Queryable, caravanId: string, forUpdate = false): Promise<TripRow | null> {
  const res = await db.query<TripRow>(`SELECT * FROM trip WHERE caravan_id = $1 AND ended_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`, [caravanId]);
  return res.rows[0] ?? null;
}

export async function findTripById(db: Queryable, id: string): Promise<TripRow | null> {
  const res = await db.query<TripRow>("SELECT * FROM trip WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

/**
 * Trip end. Chunk 15 decides when (and closes the manifest alongside) and names the reason;
 * a bare call (chunk 14's tests) leaves it null. Idempotent: an ended trip is returned as-is.
 */
export async function endTrip(client: pg.PoolClient, tripId: string, reason: TripEndReason | null = null): Promise<TripRow> {
  const res = await client.query<TripRow>("UPDATE trip SET ended_at = now(), end_reason = $2 WHERE id = $1 AND ended_at IS NULL RETURNING *", [tripId, reason]);
  if (res.rows[0]) return res.rows[0];
  const existing = await findTripById(client, tripId);
  if (!existing) throw new AppError(404, "no_trip", "trip not found");
  return existing;
}
