/**
 * Snapshots taken at enqueue time and frozen into the job's input. A fight is resolved
 * against these copies, never against the live rows, so:
 *   - the standing party is read-only during resolution (it is a template; GUARDRAILS §0),
 *     and its owner editing it afterwards does not change what the replay shows;
 *   - the same party can be served into any number of concurrent encounters, each reading
 *     its own identical snapshot, with no lock on the party at all;
 *   - the formation the defender committed is the formation that was resolved.
 *
 * Chunk 09 widens the party snapshot with composition, stances and approach edges; chunk
 * 07 widens the formation. Both keep the shape plain JSON with integer numbers.
 */
import type { Queryable } from "../db/pool.js";
import type { StandingPartyRow } from "../db/types.js";
import type { JsonObject } from "../ledger/events.js";

export interface StandingPartySnapshot extends JsonObject {
  ownerAccountId: string;
  /** Owner's last edit, as stored at snapshot time (ISO). Proves which version was served. */
  savedAt: string;
  /** TODO(chunk-09): composition, stances, approach edge. */
  composition: JsonObject;
}

export async function snapshotStandingParty(db: Queryable, ownerAccountId: string): Promise<StandingPartySnapshot> {
  const res = await db.query<StandingPartyRow & { composition?: JsonObject }>(
    "SELECT * FROM standing_party WHERE account_id = $1",
    [ownerAccountId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`standing party for account ${ownerAccountId} not found`);
  return {
    ownerAccountId: row.account_id,
    savedAt: row.updated_at.toISOString(),
    composition: row.composition ?? {},
  };
}

/** A formation as committed by the defender for one encounter. TODO(chunk-07): real shape. */
export interface FormationSnapshot extends JsonObject {
  fences: JsonObject[];
  traps: JsonObject[];
  posts: JsonObject[];
}

/** Deep-copy and validate the committed formation so the caller's object can't alias it. */
export function snapshotFormation(formation: JsonObject): FormationSnapshot {
  const copy = JSON.parse(JSON.stringify(formation)) as JsonObject;
  const arr = (k: string): JsonObject[] => {
    const v = copy[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new TypeError(`formation.${k} must be an array`);
    return v as JsonObject[];
  };
  return { ...copy, fences: arr("fences"), traps: arr("traps"), posts: arr("posts") };
}
