/**
 * The encounter-resolution job: enqueue side (formation snapshot + the survivors it was
 * committed against + the pre-taken party snapshot + the content stamp + formation_committed
 * event) and the pure handler the worker runs.
 *
 * Chunk 13 wired the resolver: ENCOUNTER_RESOLUTION_WIRED is true and DEFAULT_HANDLERS
 * resolves through the trip loop's seam with the production adapter
 * (trip/resolverAdapter.ts). The gate stays a server-side flag, NOT `RESOLVER_VERSION`
 * (QA-02 S9). The handler returns the outcome (job.result.outcome), the two resolution events
 * and the replay log as an ARTIFACT the worker stores in `encounter_log` in the same
 * transaction (QA-15 S2) — the log never goes in job.result, only its hash and size do. Coin,
 * unit and Reputation effects are NOT written here: the trip loop's settle step
 * (trip/service.ts) folds the stored outcome in once. The PLACEHOLDER handler is kept for
 * chunk 02's queue tests only.
 */
import { RESOLVER_VERSION } from "@caravan/resolver";
import { createHash } from "node:crypto";
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
import { ContentHashMismatchError, RESOLUTION_CONTENT_HASH } from "../../trip/resolverAdapter.js";
import type { EncounterLogArtifact, JobHandler } from "../worker.js";

export interface EncounterJobInput extends JsonObject {
  tripId: string;
  encounterIndex: number;
  defenderAccountId: string;
  defenderCaravanId: string;
  partyOwnerAccountId: string;
  formation: FormationSnapshot;
  /** QA-15 N3: the survivors the formation was committed against (trip loop jobs only), top-level. */
  survivors?: JsonObject;
  party: StandingPartySnapshot;
  /** Version the enqueuer expects to resolve with; the handler stamps the real one too. */
  resolverVersion: number;
  /** QA-15 S3: sha256 of the content + tunables the resolution will read (RESOLUTION_CONTENT_HASH at enqueue). */
  contentHash: string;
}

export interface EnqueueEncounterInput {
  tripId: string;
  encounterIndex: number;
  defenderAccountId: string;
  defenderCaravanId: string;
  partyOwnerAccountId: string;
  formation: JsonObject;
  /** QA-15 N3: the trip loop's survivors snapshot, stored as its own top-level job-input key. */
  survivors?: JsonObject;
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
  const survivors = input.survivors === undefined ? undefined : (JSON.parse(JSON.stringify(input.survivors)) as JsonObject);
  const existing = await getJob(client, id);
  if (existing) {
    const stored = existing.input as EncounterJobInput;
    const sameSurvivors = canonicalJson((stored.survivors ?? null) as Json) === canonicalJson((survivors ?? null) as Json);
    if (canonicalJson(stored.formation as Json) !== canonicalJson(formation) || !sameSurvivors || existing.account_id !== input.defenderAccountId || existing.caravan_id !== input.defenderCaravanId) {
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
    ...(survivors === undefined ? {} : { survivors }),
    party,
    resolverVersion: RESOLVER_VERSION,
    contentHash: RESOLUTION_CONTENT_HASH,
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
 * Whether the production handler runs the real resolver. Chunk 13 wired it (true); while it
 * was false every encounter job parked (QA-02 S9).
 */
export const ENCOUNTER_RESOLUTION_WIRED: boolean = true;

/**
 * Pure. The production handler: the trip loop's seam with the @caravan/resolver adapter.
 * If the gate is ever turned off again it refuses to resolve anything (the job parks with a
 * clear last_error rather than committing a permanent, replayable "resolution" of nothing).
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
    let encounterLog: EncounterLogArtifact | undefined;
    try {
      const resolverInput = resolverInputFromJob(job.input);
      const resolved = resolveEncounter(resolver, resolverInput);
      outcome = resolved.outcome;
      // Dry-run the carry-forward fold against the survivors the formation was committed
      // with: an outcome that heals, re-arms, rebuilds or names an unknown ref is refused
      // HERE, before anything is recorded (no repair, no resupply — chunk 15).
      applyAttritionOutcome(resolverInput.survivors, attritionOf(outcome));
      if (resolved.log !== null) {
        const text = JSON.stringify(resolved.log);
        const sha = (v: unknown) => createHash("sha256").update(canonicalJson(v as Json)).digest("hex");
        encounterLog = {
          jobId: job.id,
          caravanId: input.defenderCaravanId,
          defenderAccountId: input.defenderAccountId,
          partyOwnerAccountId: input.partyOwnerAccountId,
          resolverVersion: resolved.log.resolverVersion,
          logFormat: resolved.log.v,
          text,
          sha256: createHash("sha256").update(text).digest("hex"),
          formationSha256: sha(input.formation),
          survivorsSha256: sha(input.survivors ?? null),
          partySha256: sha(input.party),
          contentHash: input.contentHash,
        };
      }
    } catch (err) {
      // QA-15 S3: a content mismatch is retryable — a worker on the stamped content can take it.
      if (err instanceof ContentHashMismatchError) throw err;
      throw new NonRetryableJobError(`encounter ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const outcomeJson = outcome as unknown as JsonObject;
    const summary = { kind: outcome.kind, depth: outcome.depth, endTick: outcome.endTick, loot: outcome.loot };
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
          partyId: input.party.partyId,
          partyHash: input.party.hash,
          partySavedAt: input.party.savedAt,
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
          outcome: summary,
        },
      },
    ];
    // QA-15 S2: the log lives in encounter_log; the result names it (hash + size), never holds it.
    const replay: JsonObject | null = encounterLog ? { store: "encounter_log", jobId: job.id, logFormat: encounterLog.logFormat, sha256: encounterLog.sha256, rawBytes: Buffer.byteLength(encounterLog.text) } : null;
    return { events, result: { outcome: outcomeJson, resolverVersion: RESOLVER_VERSION, resolver: resolver.name, replay }, ...(encounterLog ? { encounterLog } : {}) };
  };
}

export const DEFAULT_HANDLERS = { [JOB_KIND_ENCOUNTER_RESOLUTION]: encounterResolutionHandler } as const;

/** For tests only: resolves encounters with the placeholder outcome. */
export const PLACEHOLDER_HANDLERS = { [JOB_KIND_ENCOUNTER_RESOLUTION]: placeholderEncounterResolutionHandler } as const;
