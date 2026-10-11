/**
 * The encounter-resolution job: enqueue side (formation snapshot + the pre-taken party
 * snapshot + formation_committed event) and the pure handler the worker runs.
 *
 * The handler's outcome is a PLACEHOLDER until the resolver is wired in (chunk 13). The
 * placeholder is exported for tests; the production DEFAULT_HANDLERS entry refuses to run
 * while ENCOUNTER_RESOLUTION_WIRED is false (QA-02 S9), so no permanent resolution of
 * nothing is written. The gate is a server-side flag, NOT `RESOLVER_VERSION`: chunk 10
 * shipped the resolver core at RESOLVER_VERSION 1 (movement and breaching only — no combat,
 * no end conditions, no outcome), so the version alone does not mean "an encounter can be
 * resolved". TODO(chunk-13): implement trip/outcome.ts `productionEncounterResolver` over
 * @caravan/resolver (chunk 15 built the handler around it: `makeEncounterResolutionHandler`)
 * and flip ENCOUNTER_RESOLUTION_WIRED. Coin, unit and Reputation effects are NOT written
 * here: the trip loop's settle step (trip/service.ts) folds the stored outcome in once.
 * Nothing else about this file changes then: the snapshotting, the events' scopes and the
 * resolver-version stamp are already in place.
 */
import { RESOLVER_VERSION } from "@caravan/resolver";
import type pg from "pg";
import type { ResolutionJobRow } from "../../db/types.js";
import type { JsonObject, LedgerEventDraft } from "../../ledger/events.js";
import { canonicalJson, type Json } from "../../ledger/events.js";
import { appendEvents, lockCaravanForResolution } from "../../ledger/ledger.js";
import { JOB_KIND_ENCOUNTER_RESOLUTION, JobInputConflictError, NonRetryableJobError, encounterJobId, enqueueJob, getJob } from "../queue.js";
import { snapshotFormation, type FormationSnapshot, type StandingPartySnapshot } from "../snapshots.js";
import { applyEncounterOutcome as applyAttritionOutcome } from "@caravan/circle";
import {
  attritionOf,
  productionEncounterResolver,
  resolveEncounter,
  resolverInputFromJob,
  type EncounterOutcome,
  type EncounterResolver,
} from "../../trip/outcome.js";
import type { JobHandler } from "../worker.js";

export interface EncounterJobInput extends JsonObject {
  tripId: string;
  encounterIndex: number;
  defenderAccountId: string;
  defenderCaravanId: string;
  partyOwnerAccountId: string;
  formation: FormationSnapshot;
  party: StandingPartySnapshot;
  /** Version the enqueuer expects to resolve with; the handler stamps the real one too. */
  resolverVersion: number;
}

export interface EnqueueEncounterInput {
  tripId: string;
  encounterIndex: number;
  defenderAccountId: string;
  defenderCaravanId: string;
  partyOwnerAccountId: string;
  formation: JsonObject;
  /**
   * Chunk 14: the party snapshot taken ONCE when the candidate menu was generated and
   * stored on the chosen candidate (`enqueueChosenEncounter`). Stored into the job input
   * as-is, so what the defender scouted is byte-for-byte what is fought; the live party is
   * NEVER re-resolved here, and its owner editing or losing units since the search changes
   * nothing. REQUIRED (chunk 14 QA S1): there is no live-snapshot fallback, so no caller —
   * chunk 15 included — can accidentally fight a party the defender did not scout. Tests
   * that bypass matchmaking take their own snapshot with `snapshotStandingParty`.
   */
  party: StandingPartySnapshot;
}

/**
 * Commit a formation against a scouted party and queue its resolution. Runs inside the
 * caller's transaction under the caravan lock. Idempotent on (tripId, encounterIndex):
 * a second call with the SAME formation returns the first job and appends nothing; a
 * different formation for an encounter already committed is a JobInputConflictError
 * (QA-02 S4) — what was committed is what resolves. The party snapshot is not part of
 * that comparison: it was frozen by the first call, and the owner editing their party
 * since does not make a retry of the same commit a conflict.
 */
export async function enqueueEncounterResolution(
  client: pg.PoolClient,
  input: EnqueueEncounterInput,
): Promise<{ job: ResolutionJobRow; created: boolean }> {
  const id = encounterJobId(input.tripId, input.encounterIndex);
  await lockCaravanForResolution(client, input.defenderCaravanId);
  const formation = snapshotFormation(input.formation);
  const existing = await getJob(client, id);
  if (existing) {
    const stored = (existing.input as EncounterJobInput).formation as Json;
    if (canonicalJson(stored) !== canonicalJson(formation) || existing.account_id !== input.defenderAccountId || existing.caravan_id !== input.defenderCaravanId) {
      throw new JobInputConflictError(id, existing);
    }
    return { job: existing, created: false };
  }
  if (!input.party || typeof input.party !== "object") {
    throw new TypeError(`encounter ${id}: a party snapshot is required; pass the chosen candidate's snapshot (enqueueChosenEncounter) — there is no live re-resolve at commit`);
  }
  if (input.party.ownerAccountId !== input.partyOwnerAccountId) {
    throw new Error(`party snapshot belongs to account ${input.party.ownerAccountId}, not ${input.partyOwnerAccountId}`);
  }
  // Chunk 25 QA N1: when matchmaking stored a CHOSEN candidate for this encounter, that
  // candidate's snapshot is the only party this encounter may be fought against — the
  // input must equal it byte for byte (canonical JSON), owner included. Callers without a
  // chosen row (chunk 02's own tests, which take their own snapshot) are unaffected.
  const chosen = await client.query<{ snapshot: Json; owner_account_id: string | null }>(
    `SELECT c -> 'snapshot' AS snapshot, c -> 'owner' ->> 'accountId' AS owner_account_id
       FROM encounter_candidates ec CROSS JOIN LATERAL jsonb_array_elements(ec.candidates) c
      WHERE ec.trip_id::text = $1 AND ec.encounter_index = $2 AND ec.chosen_at IS NOT NULL
        AND c ->> 'candidateId' = ec.chosen_candidate_id`,
    [input.tripId, input.encounterIndex],
  );
  const chosenRow = chosen.rows[0];
  if (chosenRow && (canonicalJson(chosenRow.snapshot) !== canonicalJson(input.party as unknown as Json) || chosenRow.owner_account_id !== input.partyOwnerAccountId)) {
    throw new Error(`encounter ${id}: the party snapshot is not the chosen candidate's; a chosen encounter is fought only against the snapshot the defender scouted`);
  }
  const party = input.party;
  const jobInput: EncounterJobInput = {
    tripId: input.tripId,
    encounterIndex: input.encounterIndex,
    defenderAccountId: input.defenderAccountId,
    defenderCaravanId: input.defenderCaravanId,
    partyOwnerAccountId: input.partyOwnerAccountId,
    formation,
    party,
    resolverVersion: RESOLVER_VERSION,
  };
  const { job, created } = await enqueueJob(client, {
    id,
    kind: JOB_KIND_ENCOUNTER_RESOLUTION,
    accountId: input.defenderAccountId,
    caravanId: input.defenderCaravanId,
    input: jobInput,
  });
  if (created) {
    await appendEvents(client, `enqueue:${id}`, [
      {
        type: "formation_committed",
        accountId: input.defenderAccountId,
        caravanId: input.defenderCaravanId,
        payload: { jobId: id, tripId: input.tripId, encounterIndex: input.encounterIndex, formation, partyOwnerAccountId: input.partyOwnerAccountId, partySavedAt: party.savedAt },
      },
    ]);
  }
  return { job, created };
}

/**
 * Pure. Sees only the job input. PLACEHOLDER: records the fight as resolved with no
 * winner. Only tests may run it (they register it explicitly); DEFAULT_HANDLERS refuses
 * to write permanent "resolutions" from it (QA-02 S9), see encounterResolutionHandler.
 */
export const placeholderEncounterResolutionHandler: JobHandler = (job) => {
  const input = job.input as EncounterJobInput;
  const outcome: JsonObject = { kind: "placeholder_unresolved", resolverVersion: RESOLVER_VERSION };
  const events: LedgerEventDraft[] = [
    {
      type: "encounter_resolved",
      accountId: input.defenderAccountId,
      caravanId: input.defenderCaravanId,
      resolverVersion: RESOLVER_VERSION,
      payload: {
        jobId: job.id,
        tripId: input.tripId,
        encounterIndex: input.encounterIndex,
        partyOwnerAccountId: input.partyOwnerAccountId,
        formation: input.formation,
        party: input.party,
        outcome,
      },
    },
    {
      type: "party_served_as_encounter",
      accountId: input.partyOwnerAccountId,
      resolverVersion: RESOLVER_VERSION,
      payload: {
        jobId: job.id,
        tripId: input.tripId,
        encounterIndex: input.encounterIndex,
        defenderAccountId: input.defenderAccountId,
        defenderCaravanId: input.defenderCaravanId,
        partySavedAt: input.party.savedAt,
        outcome,
      },
    },
  ];
  return { events, result: { outcome, resolverVersion: RESOLVER_VERSION } };
};

/**
 * Whether the production handler runs the real resolver. False until chunk 13 maps a
 * resolver outcome to events; while false, every encounter job parks (QA-02 S9).
 */
export const ENCOUNTER_RESOLUTION_WIRED = false;

/**
 * Pure. The production handler. Until chunk 13 wires the resolver in it refuses to resolve
 * anything: the job parks with a clear last_error rather than committing a permanent,
 * replayable "resolution" of nothing (QA-02 S9).
 * TODO(chunk-13): call @caravan/resolver on input.formation + input.party and map its
 * outcome to coin/unit/reputation events here, replacing the placeholder body.
 */
export const encounterResolutionHandler: JobHandler = (job) => {
  if (!ENCOUNTER_RESOLUTION_WIRED) {
    throw new NonRetryableJobError(
      `no resolver: RESOLVER_VERSION ${RESOLVER_VERSION} is not wired into the encounter handler (chunk 13); encounter ${job.id} cannot be resolved until it is`,
    );
  }
  // Chunk 15: once wired, production resolves through the trip loop's seam with the real
  // resolver adapter (trip/outcome.ts productionEncounterResolver, chunk 13 implements it).
  return makeEncounterResolutionHandler(productionEncounterResolver)(job);
};

/**
 * Chunk 15 — the resolution handler over the trip loop's seam (trip/outcome.ts). PURE: it
 * parses the job's snapshotted input (formation + the survivors it was committed against +
 * the scouted party), runs `resolveEncounter(resolver, …)` and records the validated
 * EncounterOutcome in the job result and in the two resolution events. The trip loop's
 * settle step (trip/service.ts) reads `job.result.outcome` and folds it into the manifest,
 * progression and the trip's unbanked Coin — exactly once.
 *
 * Production passes `productionEncounterResolver` (gated above); tests pass the
 * deterministic double in test/trip-double.ts. The party-side event carries the party
 * version that fought (chunk 09 QA N3: partyId, partyHash, partySavedAt from the snapshot).
 * A malformed input or outcome is a NonRetryableJobError: retrying a pure function cannot fix it.
 */
export function makeEncounterResolutionHandler(resolver: EncounterResolver): JobHandler {
  return (job) => {
    const input = job.input as EncounterJobInput;
    let outcome: EncounterOutcome;
    try {
      const resolverInput = resolverInputFromJob(job.input);
      outcome = resolveEncounter(resolver, resolverInput);
      // Dry-run the carry-forward fold against the survivors the formation was committed
      // with: an outcome that heals, re-arms, rebuilds or names an unknown ref is refused
      // HERE, before anything is recorded (no repair, no resupply — chunk 15).
      applyAttritionOutcome(resolverInput.survivors, attritionOf(outcome));
    } catch (err) {
      throw new NonRetryableJobError(`encounter ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const outcomeJson = outcome as unknown as JsonObject;
    const events: LedgerEventDraft[] = [
      {
        type: "encounter_resolved",
        accountId: input.defenderAccountId,
        caravanId: input.defenderCaravanId,
        resolverVersion: RESOLVER_VERSION,
        payload: {
          jobId: job.id,
          tripId: input.tripId,
          encounterIndex: input.encounterIndex,
          partyOwnerAccountId: input.partyOwnerAccountId,
          formation: input.formation,
          party: input.party,
          outcome: outcomeJson,
        },
      },
      {
        type: "party_served_as_encounter",
        accountId: input.partyOwnerAccountId,
        resolverVersion: RESOLVER_VERSION,
        payload: {
          jobId: job.id,
          tripId: input.tripId,
          encounterIndex: input.encounterIndex,
          defenderAccountId: input.defenderAccountId,
          defenderCaravanId: input.defenderCaravanId,
          partyId: input.party.partyId,
          partyHash: input.party.hash,
          partySavedAt: input.party.savedAt,
          outcome: { kind: outcome.kind, depth: outcome.depth },
        },
      },
    ];
    return { events, result: { outcome: outcomeJson, resolverVersion: RESOLVER_VERSION, resolver: resolver.name } };
  };
}

export const DEFAULT_HANDLERS = { [JOB_KIND_ENCOUNTER_RESOLUTION]: encounterResolutionHandler } as const;

/** For tests only: resolves encounters with the placeholder outcome. */
export const PLACEHOLDER_HANDLERS = { [JOB_KIND_ENCOUNTER_RESOLUTION]: placeholderEncounterResolutionHandler } as const;
