/**
 * The encounter-resolution job: enqueue side (snapshot + formation_committed event) and
 * the pure handler the worker runs.
 *
 * The handler's outcome is a PLACEHOLDER until the resolver exists (chunks 10–13). The
 * placeholder is exported for tests; the production DEFAULT_HANDLERS entry refuses to run
 * while RESOLVER_VERSION < 1 (QA-02 S9), so no permanent resolution of nothing is written.
 * TODO(chunk-13): call @caravan/resolver on input.formation + input.party and map its
 * outcome to coin/unit/reputation events here, and bump RESOLVER_VERSION to >= 1. Nothing
 * else about this file changes then: the snapshotting, the events' scopes and the
 * resolver-version stamp are already in place.
 */
import { RESOLVER_VERSION } from "@caravan/resolver";
import type pg from "pg";
import type { ResolutionJobRow } from "../../db/types.js";
import type { JsonObject, LedgerEventDraft } from "../../ledger/events.js";
import { canonicalJson, type Json } from "../../ledger/events.js";
import { appendEvents, lockCaravanForResolution } from "../../ledger/ledger.js";
import { JOB_KIND_ENCOUNTER_RESOLUTION, JobInputConflictError, NonRetryableJobError, encounterJobId, enqueueJob, getJob } from "../queue.js";
import { snapshotFormation, snapshotStandingParty, type FormationSnapshot, type StandingPartySnapshot } from "../snapshots.js";
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
  const party = await snapshotStandingParty(client, input.partyOwnerAccountId);
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

/** The resolver version below which no real resolver exists (chunk 13 bumps it to >= 1). */
export const FIRST_REAL_RESOLVER_VERSION = 1;

/**
 * Pure. The production handler. Until chunk 13 lands a resolver (RESOLVER_VERSION >= 1)
 * it refuses to resolve anything: the job parks with a clear last_error rather than
 * committing a permanent, replayable "resolution" of nothing (QA-02 S9).
 * TODO(chunk-13): call @caravan/resolver on input.formation + input.party and map its
 * outcome to coin/unit/reputation events here, replacing the placeholder body.
 */
export const encounterResolutionHandler: JobHandler = (job) => {
  if (RESOLVER_VERSION < FIRST_REAL_RESOLVER_VERSION) {
    throw new NonRetryableJobError(
      `no resolver: RESOLVER_VERSION ${RESOLVER_VERSION} is the pre-chunk-13 placeholder; encounter ${job.id} cannot be resolved until the resolver ships`,
    );
  }
  return placeholderEncounterResolutionHandler(job);
};

export const DEFAULT_HANDLERS = { [JOB_KIND_ENCOUNTER_RESOLUTION]: encounterResolutionHandler } as const;

/** For tests only: resolves encounters with the placeholder outcome. */
export const PLACEHOLDER_HANDLERS = { [JOB_KIND_ENCOUNTER_RESOLUTION]: placeholderEncounterResolutionHandler } as const;
