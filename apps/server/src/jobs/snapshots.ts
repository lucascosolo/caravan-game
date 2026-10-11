/**
 * Snapshots frozen into the job's input: the formation is snapshotted at enqueue, the
 * standing party ONCE at candidate-menu generation (chunk 14 `searchCandidates`), stored on
 * the candidate and handed to the enqueue as-is. A fight is resolved against these copies,
 * never against the live rows, so:
 *   - the standing party is read-only during resolution (it is a template; GUARDRAILS §0),
 *     and its owner editing it afterwards does not change what the replay shows;
 *   - the same party can be served into any number of concurrent encounters, each reading
 *     its own identical snapshot, with no lock on the party at all;
 *   - the formation the defender committed is the formation that was resolved.
 *
 * Chunk 09: the party snapshot is the party RESOLVED against the owner's live roster and
 * unlock web at snapshot time (@caravan/circle `Party`, canonical, integers only): every
 * unit's instance id, type, merge level, stance, approach edge and starting cell, and
 * every siege piece. It is a COPY — nothing on the resolution path can reach the party
 * row or the roster through it. A party that no longer resolves (an instance it names was
 * lost on the owner's trip or consumed by a merge) cannot be served: snapshotStandingParty
 * throws StandingPartyInvalidError, which can only surface at menu GENERATION — matchmaking
 * (chunk 14) skips that party there, records its id in `encounter_candidates.skipped_party_ids`
 * and draws another. There is no re-scout: once a candidate is on a menu its snapshot is
 * what is fought, whatever happens to the live party afterwards (chunk 14 QA N3). The
 * enqueue (`enqueueEncounterResolution`) requires the pre-taken snapshot and never calls
 * this for a live party. Chunk 07 widened the formation.
 */
import { partyConfigFromJson, serializeParty, serializePartyConfig, type Issue } from "@caravan/circle";
import type { Queryable } from "../db/pool.js";
import type { JsonObject } from "../ledger/events.js";
import { partyHash, resolveStandingParty } from "../party/service.js";

export interface StandingPartySnapshot extends JsonObject {
  ownerAccountId: string;
  partyId: string;
  slot: number;
  /** Owner's last edit, as stored at snapshot time (ISO). Proves which version was served. */
  savedAt: string;
  /** sha256 of the canonical stored config at snapshot time. */
  hash: string;
  /** The resolved @caravan/circle Party, canonical form. `partyFromJson` reads it back. */
  composition: JsonObject;
}

export class StandingPartyInvalidError extends Error {
  constructor(
    public readonly ownerAccountId: string,
    public readonly issues: readonly Issue[],
  ) {
    super(`standing party of account ${ownerAccountId} does not resolve against its roster and cannot be served: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "StandingPartyInvalidError";
  }
}

/**
 * The party row is read FOR SHARE (chunk 09 QA N5): inside the enqueuing transaction this
 * holds the row against a concurrent edit until the roster has been read too, so one
 * snapshot never mixes an old config with the roster a new save was validated against.
 * The snapshot carries `partyId` and `hash`; chunk 13's `party_served_as_encounter`
 * payload must carry both (QA N3) so a feed entry names exactly which party version fought.
 */
export async function snapshotStandingParty(db: Queryable, ownerAccountId: string): Promise<StandingPartySnapshot> {
  const r = await resolveStandingParty(db, ownerAccountId, { lock: "share" });
  if (!r) throw new Error(`standing party for account ${ownerAccountId} not found`);
  if (!r.result.ok) throw new StandingPartyInvalidError(ownerAccountId, r.result.issues);
  const canonical = serializeParty(r.result.value);
  return {
    ownerAccountId: r.row.account_id,
    partyId: r.row.id,
    slot: r.row.slot,
    savedAt: r.row.updated_at.toISOString(),
    // jsonb normalizes key order, so the hash is of the stored config RE-canonicalized —
    // the same text the service hashed at save time, so snapshot.hash equals the view's.
    hash: partyHash(serializePartyConfig(partyConfigFromJson(r.row.composition))),
    composition: JSON.parse(canonical) as JsonObject,
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
