/**
 * The trip row (migration 009) — the SEAM chunk 15 builds the trip loop on. Chunk 14 needs
 * a trip id to seed candidate menus from and to key encounter candidates by; chunk 15 owns
 * when a trip starts (trip cap, caravan.state) and ends (bank / overrun / stalemate). Until
 * then these two functions are the only writers and tests call them directly.
 *
 * CARAVAN-level (GUARDRAILS §5). No geography, no route, no travel timer (chunk 15 brief).
 */
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
}

/**
 * Open a trip on the caravan's open manifest. Chunk 15 wraps this with the trip cap and the
 * caravan state change; here it only refuses a caravan with nothing packed or already out.
 */
export async function createTrip(client: pg.PoolClient, caravanId: string): Promise<TripRow> {
  await client.query("SELECT id FROM caravan WHERE id = $1 FOR UPDATE", [caravanId]);
  const manifest = await findOpenManifest(client, caravanId);
  if (!manifest) throw new AppError(404, "no_open_manifest", "this caravan is in town with nothing packed");
  if (await findOpenTrip(client, caravanId)) throw conflict("trip_open", "this caravan is already on a trip");
  const res = await client.query<TripRow>("INSERT INTO trip (caravan_id, manifest_id) VALUES ($1, $2) RETURNING *", [caravanId, manifest.id]);
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

/** Trip end. Chunk 15 decides when (and closes the manifest alongside). Idempotent. */
export async function endTrip(client: pg.PoolClient, tripId: string): Promise<TripRow> {
  const res = await client.query<TripRow>("UPDATE trip SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING *", [tripId]);
  if (res.rows[0]) return res.rows[0];
  const existing = await findTripById(client, tripId);
  if (!existing) throw new AppError(404, "no_trip", "trip not found");
  return existing;
}
