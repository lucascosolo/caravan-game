/**
 * The encounter-resolution job: enqueue side (snapshot + formation_committed event) and
 * the pure handler the worker runs.
 *
 * The handler's outcome is a PLACEHOLDER until the resolver exists (chunks 10–13): it
 * records the fight as resolved with no winner, no Coin movement and no unit effects.
 * TODO(chunk-13): call @caravan/resolver on input.formation + input.party and map its
 * outcome to coin/unit/reputation events here. Nothing else about this file changes then:
 * the snapshotting, the events' scopes and the resolver-version stamp are already in place.
 */
import { RESOLVER_VERSION } from "@caravan/resolver";
import type pg from "pg";
import type { ResolutionJobRow } from "../../db/types.js";
import type { JsonObject, LedgerEventDraft } from "../../ledger/events.js";
import { appendEvents, lockCaravanForResolution } from "../../ledger/ledger.js";
import { JOB_KIND_ENCOUNTER_RESOLUTION, encounterJobId, enqueueJob } from "../queue.js";
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
 * a second call returns the first job and appends nothing.
 */
export async function enqueueEncounterResolution(
  client: pg.PoolClient,
  input: EnqueueEncounterInput,
): Promise<{ job: ResolutionJobRow; created: boolean }> {
  const id = encounterJobId(input.tripId, input.encounterIndex);
  await lockCaravanForResolution(client, input.defenderCaravanId);
  const party = await snapshotStandingParty(client, input.partyOwnerAccountId);
  const formation = snapshotFormation(input.formation);
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

/** Pure. Sees only the job input. */
export const encounterResolutionHandler: JobHandler = (job) => {
  const input = job.input as EncounterJobInput;
  // TODO(chunk-13): const outcome = resolve(input.formation, input.party) from @caravan/resolver.
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

export const DEFAULT_HANDLERS = { [JOB_KIND_ENCOUNTER_RESOLUTION]: encounterResolutionHandler } as const;
