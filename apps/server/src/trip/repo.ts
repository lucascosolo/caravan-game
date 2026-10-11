/**
 * Row access for the trip loop's table (migration 012, trip_encounter). Plain SQL; the
 * permanence rules (immutable once settled, one decision, settled in order, history
 * undeletable) live in the database triggers.
 */
import type { Queryable } from "../db/pool.js";
import { conflict } from "../services/errors.js";
import type { EncounterOutcomeKind } from "./outcome.js";

export type TripDecision = "pushed" | "banked";

export interface TripEncounterRow {
  trip_id: string;
  encounter_index: number;
  job_id: string;
  outcome_kind: EncounterOutcomeKind;
  depth_fp: number;
  /** Unit refs whose HP reached 0 in this encounter. */
  deaths: string[];
  /** Unbanked Coin this encounter is worth to the caravan (0 on an overrun). */
  coin_accrued: number;
  party_owner_account_id: string;
  decision: TripDecision | null;
  decided_at: Date | null;
  settled_at: Date;
}

export async function findTripEncounter(db: Queryable, tripId: string, encounterIndex: number, forUpdate = false): Promise<TripEncounterRow | null> {
  const res = await db.query<TripEncounterRow>(
    `SELECT * FROM trip_encounter WHERE trip_id = $1 AND encounter_index = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [tripId, encounterIndex],
  );
  return res.rows[0] ?? null;
}

export async function listTripEncounters(db: Queryable, tripId: string): Promise<TripEncounterRow[]> {
  const res = await db.query<TripEncounterRow>("SELECT * FROM trip_encounter WHERE trip_id = $1 ORDER BY encounter_index", [tripId]);
  return res.rows;
}

export async function insertTripEncounter(
  db: Queryable,
  row: Pick<TripEncounterRow, "trip_id" | "encounter_index" | "job_id" | "outcome_kind" | "depth_fp" | "deaths" | "coin_accrued" | "party_owner_account_id">,
): Promise<TripEncounterRow> {
  const res = await db.query<TripEncounterRow>(
    `INSERT INTO trip_encounter (trip_id, encounter_index, job_id, outcome_kind, depth_fp, deaths, coin_accrued, party_owner_account_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
    [row.trip_id, row.encounter_index, row.job_id, row.outcome_kind, row.depth_fp, JSON.stringify(row.deaths), row.coin_accrued, row.party_owner_account_id],
  );
  return res.rows[0]!;
}

export async function decideTripEncounter(db: Queryable, tripId: string, encounterIndex: number, decision: TripDecision): Promise<TripEncounterRow> {
  const res = await db.query<TripEncounterRow>(
    `UPDATE trip_encounter SET decision = $3, decided_at = now()
      WHERE trip_id = $1 AND encounter_index = $2 AND decision IS NULL RETURNING *`,
    [tripId, encounterIndex, decision],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`trip_encounter ${tripId}/${encounterIndex} not found or already decided`);
  return row;
}

/** Sum of the trip's unbanked Coin: what a bank credits and what an overrun puts at stake. */
export function unbankedCoinOf(rows: readonly TripEncounterRow[]): number {
  return rows.reduce((sum, r) => sum + r.coin_accrued, 0);
}

/**
 * Chunk 15 gate for serving encounter n (> 1): the trip loop must have recorded a PUSH past
 * encounter n − 1. Refuses while the bank-or-push decision is still open (or was a bank).
 * When the trip loop has no row for n − 1 at all (only possible on paths that bypass it —
 * chunk 14's own tests move the manifest counter by hand), there is nothing to gate on.
 */
export async function assertPushedPast(db: Queryable, tripId: string, encounterIndex: number): Promise<void> {
  if (encounterIndex <= 1) return;
  const prev = await findTripEncounter(db, tripId, encounterIndex - 1);
  if (prev && prev.decision !== "pushed") {
    throw conflict("decide_first", `encounter ${encounterIndex - 1} was survived; bank or push before the next party is served`);
  }
}
