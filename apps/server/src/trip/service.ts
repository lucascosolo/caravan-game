/**
 * THE TRIP LOOP (chunk 15). The outer loop of the ACTIVE side (GUARDRAILS §0): the player
 * escorts a caravan out of town into a chain of individually matchmade, individually
 * scoutable attacking parties, defends at each one, and after surviving chooses to BANK
 * (deliver; keep everything) or PUSH (the next, harder party; nothing repaired).
 *
 * A trip is a chain of encounters and nothing else: no map, no route, no travel timer.
 *
 *   startTrip        town → trail. Consumes one trip-cap use, flips caravan.state to
 *                    on_trip, opens the trip row on the packed (already locked) manifest,
 *                    appends `trip_started`. Refuses without a packed manifest.
 *   per encounter n  search → choose (chunk 14 routes) → arrange (chunk 07 routes) →
 *                    commitEncounter (freeze the formation, queue its resolution with the
 *                    scouted snapshot) → resolution job (trip/outcome.ts seam) →
 *                    settleEncounter (fold the outcome in, exactly once).
 *   settleEncounter  attrition into the manifest (chunk 07 applyOutcome: monotone, no
 *                    repair), progression for both sides (chunk 04 applyEncounterOutcome;
 *                    party side skipped for a system owner), the encounter's Coin accrued as
 *                    UNBANKED trip state (never the account balance), and on an overrun the
 *                    trip's end — the hand-off point for chunk 19's losses.
 *   pushTrip         after surviving n: on to n + 1. Binding — the next party is served only
 *                    after a push, so scouting it is not a free peek before deciding.
 *   bankTrip         after surviving n: credit the trip via chunk 16's creditBankedTrip
 *                    exactly once, end the trip, close the manifest (the refit: the next trip
 *                    packs fresh, at full HP and fully restocked), caravan back in town.
 *   stakesPreview    before bank-or-push: exactly what is at stake (GUARDRAILS §4).
 *
 * LOCK ORDER, every transaction here (deadlock-free against the worker, the enqueue and the
 * merge board): caravan resolution lock (advisory) → account append locks, sorted →
 * caravan row → trip row → manifest row. The worker takes caravan lock → account locks;
 * merges take account lock → caravan row FOR SHARE; neither inverts this order.
 *
 * Determinism (GUARDRAILS §1): nothing here decides an outcome. The outcome is a pure
 * function of the job input; the Coin schedule is chunk 16's integer table by encounter
 * index; escalation is chunk 14's integer function of the index. The wall clock enters
 * only as `nowMs` for the trip cap (when a trip may start) and the trickle flush.
 */
import {
  formationFromJson,
  manifestFromJson,
  serializeFormation,
  serializeManifest,
  type Manifest,
} from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import type pg from "pg";
import { applyOutcome, closeManifest } from "../circle/service.js";
import { findFormation, findManifestById, findOpenManifest, type WagonManifestRow } from "../circle/repo.js";
import type { Queryable } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import type { CaravanRow, Pool, ResolutionJobRow } from "../db/types.js";
import { coinForBankedTrip, coinForEncounter, coinForEncountersSurvived, creditBankedTrip, overflowForecast } from "../economy/coin.js";
import { peekTrickle } from "../economy/trickle.js";
import { encounterJobId, getJob } from "../jobs/queue.js";
import type { JsonObject, LedgerEventRow } from "../ledger/events.js";
import { appendEvents, listEventsByCausation, lockAccountForAppend, lockAccountsForAppend, lockCaravanForResolution } from "../ledger/ledger.js";
import { ESCALATION_PER_ENCOUNTER, escalationFor } from "../matchmaking/band.js";
import { chosenCandidate, enqueueChosenEncounter } from "../matchmaking/service.js";
import { createTrip, endTrip, findOpenTrip, findTripById, type TripRow } from "../matchmaking/trips.js";
import { applyEncounterOutcome, progressionCausationId } from "../progression/outcome.js";
import { setCaravanState } from "../repo/caravans.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { consumeTripCap, readTripCap, type TripCapView } from "./cap.js";
import { JOB_SURVIVORS_KEY, assertTripEncounterOutcome, attritionOf, caravanSurvived, resolverInputFromJob, type EncounterOutcome, type EncounterOutcomeKind } from "./outcome.js";
import { decideTripEncounter, findTripEncounter, insertTripEncounter, listTripEncounters, unbankedCoinOf, type TripEncounterRow } from "./repo.js";

const notFound = (code: string, message: string) => new AppError(404, code, message);

/** Causation ids: one per trip transition, so a retry can never write a transition twice. */
export const tripCausation = {
  start: (tripId: string) => `trip:${tripId}:start`,
  bankCoin: (tripId: string) => `trip:${tripId}:bank`,
  banked: (tripId: string) => `trip:${tripId}:banked`,
  overrun: (tripId: string) => `trip:${tripId}:overrun`,
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface TripStartResult {
  trip: TripRow;
  cap: { before: TripCapView; after: TripCapView };
  event: LedgerEventRow;
}

/**
 * Town → trail, in one transaction. The manifest was packed and locked in town (chunk 07 /
 * 17: packing never moves caravan.state); this is the moment it rides out. Two concurrent
 * starts serialize on the caravan lock: the second sees the open trip and is refused
 * (409 trip_open) without consuming a use.
 */
export async function startTrip(client: pg.PoolClient, caravan: CaravanRow, nowMs: number): Promise<TripStartResult> {
  await lockCaravanForResolution(client, caravan.id);
  await lockAccountForAppend(client, caravan.account_id);
  const live = await client.query<CaravanRow>("SELECT * FROM caravan WHERE id = $1 FOR UPDATE", [caravan.id]);
  const row = live.rows[0];
  if (!row) throw notFound("no_caravan", "caravan not found");
  const open = await findOpenTrip(client, caravan.id);
  if (open || row.state === "on_trip") throw conflict("trip_open", `this caravan is already on a trip${open ? ` (${open.id})` : ""}`);
  const manifest = await findOpenManifest(client, caravan.id, true);
  if (!manifest) throw conflict("not_packed", "pack the caravan in town first: a trip rides out with a locked manifest");
  const used = await client.query<{ id: string }>("SELECT id FROM trip WHERE manifest_id = $1", [manifest.id]);
  if (used.rows[0]) throw conflict("manifest_used", "this manifest already rode out on a trip; pack again in town");
  const cap = await consumeTripCap(client, caravan.account_id, nowMs);
  // On the trail BEFORE the trip row exists, in the same transaction (chunk 07 QA N7):
  // there is no instant at which the trip is open and the caravan reads as in town.
  await setCaravanState(client, caravan.id, "on_trip");
  const trip = await createTrip(client, caravan.id);
  const [event] = await appendEvents(client, tripCausation.start(trip.id), [
    {
      type: "trip_started",
      accountId: caravan.account_id,
      caravanId: caravan.id,
      payload: {
        tripId: trip.id,
        manifestId: manifest.id,
        startedAtMs: nowMs,
        tripCap: { availableBefore: cap.before.available, availableAfter: cap.after.available, cap: cap.after.cap },
      },
    },
  ]);
  return { trip, cap, event: event! };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Commit an encounter (freeze + queue)
// ─────────────────────────────────────────────────────────────────────────────────────────

async function lockOpenTrip(client: pg.PoolClient, caravan: CaravanRow): Promise<{ trip: TripRow; manifest: WagonManifestRow }> {
  const trip = await findOpenTrip(client, caravan.id, true);
  if (!trip) throw notFound("no_trip", "this caravan is in town; start a trip first");
  const manifest = await findManifestById(client, trip.manifest_id, true);
  if (!manifest || manifest.closed_at) throw conflict("manifest_closed", "this trip's manifest is closed");
  return { trip, manifest };
}

/**
 * Commit the arranged circle for encounter n and queue its resolution against the CHOSEN,
 * scouted party (chunk 14's enqueueChosenEncounter — the job's party is byte-identical to
 * what was scouted). The job input carries the canonical formation plus the survivors it
 * was committed against (`survivors`), so the resolution is a pure function of the input.
 * Idempotent: a retry returns the same job.
 */
export async function commitEncounter(
  client: pg.PoolClient,
  caravan: CaravanRow,
  encounterIndex: number,
  commitFormation: (client: pg.PoolClient, caravan: CaravanRow, n: number) => Promise<unknown>,
): Promise<{ job: ResolutionJobRow; created: boolean }> {
  await lockCaravanForResolution(client, caravan.id);
  await lockAccountForAppend(client, caravan.account_id);
  const { trip } = await lockOpenTrip(client, caravan);
  if (encounterIndex > 1) {
    const prev = await findTripEncounter(client, trip.id, encounterIndex - 1);
    if (!prev || prev.decision !== "pushed") throw conflict("decide_first", `bank or push after encounter ${encounterIndex - 1} before committing encounter ${encounterIndex}`);
  }
  await commitFormation(client, caravan, encounterIndex);
  const row = await findFormation(client, trip.manifest_id, encounterIndex);
  if (!row?.committed_at || !row.survivors_snapshot) throw new Error(`encounter ${encounterIndex}: formation not committed with a survivors snapshot`);
  const formation = JSON.parse(serializeFormation(formationFromJson(row.formation))) as JsonObject;
  const survivors = JSON.parse(serializeManifest(manifestFromJson(row.survivors_snapshot))) as JsonObject;
  const { job, created } = await enqueueChosenEncounter(client, caravan, encounterIndex, { ...formation, [JOB_SURVIVORS_KEY]: survivors });
  return { job, created };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Settle a resolved encounter (exactly once)
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Chunk 19 hand-off. Written as the `trip_overrun` event's payload when the caravan falls.
 * Chunk 15 applies NO losses: every unit named here is still on the roster at its packed
 * merge level, and the unbanked Coin was simply never credited.
 * TODO(chunk-19): in the SAME transaction as this event, (1) destroy every instance in
 * `unitsAliveAtCollapse` (`unit_lost_on_wipe`, plus the chunk 09 standing-party
 * invalidation draft), (2) de-merge every instance in `unitsDiedOnTrip` by one level,
 * floored at 1 (`unit_demerged_on_death`) — the INVERSION: died → de-merged, survived to the
 * collapse → destroyed, (3) transfer `unbankedCoin` to `partyOwnerAccountId` capped by their
 * headroom (`coin_transferred_to_party_owner`; destroyed instead for a system owner), and
 * flip `lossesApplied` to true.
 */
export interface TripOverrunHandoff extends JsonObject {
  tripId: string;
  manifestId: string;
  /** The encounter at which the caravan fell; its party landed the final blow. */
  encounterIndex: number;
  jobId: string;
  partyOwnerAccountId: string;
  partyOwnerAuthored: boolean;
  /** All of the trip's unbanked Coin: lost by the caravan. */
  unbankedCoin: number;
  /** Alive (hp > 0) after the final encounter: lost outright (chunk 19). Merge level from the MANIFEST. */
  unitsAliveAtCollapse: { ref: string; typeId: string; mergeLevel: number; hp: number }[];
  /** Died in an encounter of this trip (including the last): de-merged, not destroyed (chunk 19). */
  unitsDiedOnTrip: { ref: string; typeId: string; mergeLevel: number; diedAtEncounter: number }[];
  /** False until chunk 19 applies the losses above. */
  lossesApplied: boolean;
}

export type SettleState =
  | { state: "no_trip" }
  | { state: "arranging"; tripId: string; encounterIndex: number }
  | { state: "resolving"; tripId: string; encounterIndex: number; jobId: string; jobStatus: string }
  | { state: "resolution_unavailable"; tripId: string; encounterIndex: number; jobId: string; lastError: string | null }
  | { state: "settled"; tripId: string; encounterIndex: number; encounter: TripEncounterRow; created: boolean; overrun: TripOverrunHandoff | null };

function poolsUsedByCaravan(formation: { posts: readonly unknown[]; traps: readonly unknown[] }): Pool[] {
  const pools: Pool[] = [];
  if (formation.posts.length > 0) pools.push("living");
  if (formation.traps.length > 0) pools.push("trap");
  return pools;
}

/** Units whose HP reached 0 in this encounter (alive before, dead after), manifest order. */
function deathsBetween(before: Manifest, after: Manifest): string[] {
  const was = new Map(before.units.map((u) => [u.ref, u.hp]));
  return after.units.filter((u) => u.hp === 0 && (was.get(u.ref) ?? 0) > 0).map((u) => u.ref);
}

/**
 * Fold a COMPLETED resolution job into the trip, exactly once. Safe to call any number of
 * times, concurrently, from any read path: the caravan lock + trip row lock + the
 * manifest's "next encounter" check make a second settle a no-op, and the DB refuses a
 * second trip_encounter row (primary key) or a counter that moves by more than one.
 * Opens its own transaction (it first reads the job without locks).
 */
export async function settleEncounter(pool: pg.Pool, caravan: CaravanRow): Promise<SettleState> {
  const trip = await findOpenTrip(pool, caravan.id);
  if (!trip) return { state: "no_trip" };
  const manifest = await findManifestById(pool, trip.manifest_id);
  if (!manifest) throw new Error(`trip ${trip.id}: manifest ${trip.manifest_id} missing`);
  const n = manifest.encounters_resolved + 1;
  const jobId = encounterJobId(trip.id, n);
  const job = await getJob(pool, jobId);
  if (!job) return { state: "arranging", tripId: trip.id, encounterIndex: n };
  if (job.status === "parked") return { state: "resolution_unavailable", tripId: trip.id, encounterIndex: n, jobId, lastError: job.last_error };
  if (job.status !== "completed") return { state: "resolving", tripId: trip.id, encounterIndex: n, jobId, jobStatus: job.status };
  const outcome = (job.result as { outcome?: unknown } | null)?.outcome;
  assertTripEncounterOutcome(outcome);
  const ownerAccountId = String((job.input as { partyOwnerAccountId?: unknown }).partyOwnerAccountId ?? "");
  if (!ownerAccountId) throw new Error(`job ${jobId} names no party owner`);

  return withTransaction(pool, async (client) => {
    await lockCaravanForResolution(client, caravan.id);
    await lockAccountsForAppend(client, [caravan.account_id, ownerAccountId]);
    const t = await client.query<TripRow>("SELECT * FROM trip WHERE id = $1 FOR UPDATE", [trip.id]);
    const m = await findManifestById(client, trip.manifest_id, true);
    const existing = await findTripEncounter(client, trip.id, n);
    if (existing) return { state: "settled", tripId: trip.id, encounterIndex: n, encounter: existing, created: false, overrun: null } as const;
    if (!t.rows[0] || t.rows[0].ended_at || !m || m.encounters_resolved + 1 !== n) {
      throw conflict("trip_moved", "the trip changed while this encounter was being settled; read it again");
    }
    return settleLocked(client, caravan, t.rows[0], m, n, job, outcome);
  });
}

async function settleLocked(
  client: pg.PoolClient,
  caravan: CaravanRow,
  trip: TripRow,
  manifest: WagonManifestRow,
  n: number,
  job: ResolutionJobRow,
  outcome: EncounterOutcome,
): Promise<SettleState> {
  const input = job.input as Record<string, unknown>;
  const ownerAccountId = input["partyOwnerAccountId"] as string;
  const resolverInput = resolverInputFromJob(input);
  const before = manifestFromJson(manifest.survivors);

  // 1. Attrition: monotone, refuses anything not in the fight, advances the counter by one.
  const afterRow = await applyOutcome(client, manifest.id, n, attritionOf(outcome));
  const after = manifestFromJson(afterRow.survivors);
  const deaths = deathsBetween(before, after);

  // 2. Progression, both sides, once per job (chunk 04; idempotent on the causation id).
  //    A system (authored) owner: the party side is skipped entirely (chunk 25 QA S8).
  const owner = await client.query<{ is_system: boolean }>("SELECT is_system FROM account WHERE id = $1", [ownerAccountId]);
  const ownerAuthored = owner.rows[0]?.is_system === true;
  await applyEncounterOutcome(client, progressionCausationId(job.id), {
    outcome: outcome.kind,
    caravan: { accountId: caravan.account_id, caravanId: caravan.id, poolsUsed: poolsUsedByCaravan(resolverInput.formation) },
    party: { ownerAccountId, poolsUsed: resolverInput.party.siege.length > 0 ? ["siege"] : [] },
    partySide: ownerAuthored ? "skip" : "apply",
  });

  // 3. The encounter's Coin: UNBANKED trip state, at risk until a bank. Never credited here.
  //    TODO(chunk-19): the sandbagging earn floor lands here via applyEarnFloor (chunk 14
  //    note), and creditBankedTrip must then credit these per-encounter amounts.
  const survived = caravanSurvived(outcome.kind);
  const encounter = await insertTripEncounter(client, {
    trip_id: trip.id,
    encounter_index: n,
    job_id: job.id,
    outcome_kind: outcome.kind,
    depth_fp: outcome.depth,
    deaths,
    coin_accrued: survived ? coinForEncounter(n) : 0,
    party_owner_account_id: ownerAccountId,
  });

  // 4. Overrun ends the trip: back to town, manifest closed, the chunk 19 hand-off recorded.
  let overrun: TripOverrunHandoff | null = null;
  if (!survived) {
    const rows = await listTripEncounters(client, trip.id);
    const diedAt = new Map<string, number>();
    for (const r of rows) for (const ref of r.deaths) diedAt.set(ref, r.encounter_index);
    overrun = {
      tripId: trip.id,
      manifestId: manifest.id,
      encounterIndex: n,
      jobId: job.id,
      partyOwnerAccountId: ownerAccountId,
      partyOwnerAuthored: ownerAuthored,
      unbankedCoin: unbankedCoinOf(rows),
      unitsAliveAtCollapse: after.units.filter((u) => u.hp > 0).map((u) => ({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, hp: u.hp })),
      unitsDiedOnTrip: after.units.filter((u) => diedAt.has(u.ref)).map((u) => ({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, diedAtEncounter: diedAt.get(u.ref)! })),
      lossesApplied: false,
    };
    await endTrip(client, trip.id, "overrun");
    await closeManifest(client, manifest.id);
    await setCaravanState(client, caravan.id, "in_town");
    await appendEvents(client, tripCausation.overrun(trip.id), [{ type: "trip_overrun", accountId: caravan.account_id, caravanId: caravan.id, payload: overrun }]);
  }
  return { state: "settled", tripId: trip.id, encounterIndex: n, encounter, created: true, overrun };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Bank or push
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface DecisionRequest {
  tripId: string;
  /** The survived encounter this decision is about — so a stale retry can never decide a later one. */
  encounterIndex: number;
}

export function parseDecision(body: unknown): DecisionRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw badRequest("bad_body", "expected { tripId, encounterIndex }");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== "tripId" && k !== "encounterIndex") throw badRequest("bad_body", `unknown key '${k}'`);
  const tripId = b["tripId"];
  const n = b["encounterIndex"];
  if (typeof tripId !== "string" || !/^[0-9a-f-]{36}$/i.test(tripId)) throw badRequest("bad_body", "tripId must be a trip id");
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 999_999) throw badRequest("bad_body", "encounterIndex must be a positive integer");
  return { tripId: tripId.toLowerCase(), encounterIndex: n };
}

async function lockTripForDecision(client: pg.PoolClient, caravan: CaravanRow, req: DecisionRequest): Promise<{ trip: TripRow; manifest: WagonManifestRow; encounter: TripEncounterRow | null }> {
  const res = await client.query<TripRow>("SELECT * FROM trip WHERE id = $1 FOR UPDATE", [req.tripId]);
  const trip = res.rows[0];
  if (!trip || trip.caravan_id !== caravan.id) throw notFound("no_trip", "trip not found");
  const manifest = await findManifestById(client, trip.manifest_id, true);
  if (!manifest) throw new Error(`trip ${trip.id}: manifest missing`);
  const encounter = await findTripEncounter(client, trip.id, req.encounterIndex, true);
  return { trip, manifest, encounter };
}

function assertDecisionOpen(trip: TripRow, manifest: WagonManifestRow, encounter: TripEncounterRow | null, req: DecisionRequest): asserts encounter is TripEncounterRow {
  if (!encounter) throw conflict("not_survived", `encounter ${req.encounterIndex} has not been survived on this trip; there is nothing to decide`);
  if (encounter.outcome_kind === "caravan_overrun") throw conflict("trip_overrun", "the caravan was overrun; the trip is over");
  if (encounter.decision === "pushed") throw conflict("already_pushed", `the caravan already pushed on past encounter ${req.encounterIndex}`);
  if (trip.ended_at) throw conflict("trip_ended", "this trip has ended");
  if (manifest.encounters_resolved !== req.encounterIndex) throw conflict("not_current", `the decision open is for encounter ${manifest.encounters_resolved}, not ${req.encounterIndex}`);
}

export interface PushResult {
  tripId: string;
  pushedPast: number;
  nextEncounter: number;
  replayed: boolean;
}

/**
 * Push: on to the next encounter, carrying every scratch, death, broken segment and spent
 * trap forward. Nothing is restored and nothing is granted for staying out — the escalating
 * Coin of the next encounter is the only reason to push (chunk 15 brief). Idempotent on
 * (trip, encounter): a retry returns `replayed: true`.
 */
export async function pushTrip(client: pg.PoolClient, caravan: CaravanRow, req: DecisionRequest): Promise<PushResult> {
  await lockCaravanForResolution(client, caravan.id);
  const { trip, manifest, encounter } = await lockTripForDecision(client, caravan, req);
  if (encounter?.decision === "pushed") return { tripId: trip.id, pushedPast: req.encounterIndex, nextEncounter: req.encounterIndex + 1, replayed: true };
  if (encounter?.decision === "banked" || trip.end_reason === "banked") throw conflict("trip_banked", "this trip was banked; the caravan is home");
  assertDecisionOpen(trip, manifest, encounter, req);
  await decideTripEncounter(client, trip.id, req.encounterIndex, "pushed");
  return { tripId: trip.id, pushedPast: req.encounterIndex, nextEncounter: req.encounterIndex + 1, replayed: false };
}

export interface BankResult {
  tripId: string;
  encountersSurvived: number;
  /** Coin the bank requested: the trip's unbanked Coin plus the delivery bonus. */
  requested: number;
  credited: number;
  discarded: number;
  balanceAfter: number | null;
  restored: BankRefit;
  replayed: boolean;
}

/** What the refit in town restores (RESTORE_ON_TRIP_END): everything, because the next trip packs fresh. */
export interface BankRefit extends JsonObject {
  unitsHealed: { ref: string; typeId: string; mergeLevel: number; hpAtBank: number; maxHp: number }[];
  trapsRestocked: number;
  fenceSegmentsRebuilt: number;
  /**
   * Units that died during the trip. TODO(chunk-19): each loses one merge level (floored at
   * 1) — DEMERGE_APPLIES_ON any death, banked or not. Chunk 15 applies nothing.
   */
  deMergePending: string[];
}

function refitOf(survivors: Manifest, deaths: readonly string[]): BankRefit {
  return {
    unitsHealed: survivors.units.filter((u) => u.hp < u.maxHp).map((u) => ({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, hpAtBank: u.hp, maxHp: u.maxHp })),
    trapsRestocked: survivors.traps.filter((t) => t.spent).length,
    fenceSegmentsRebuilt: survivors.fences.filter((f) => f.hp < f.maxHp).length,
    deMergePending: [...deaths],
  };
}

/**
 * Bank: the delivery. Offered only after surviving an encounter (held or stalemate), never
 * mid-encounter. Credits the trip through chunk 16's `creditBankedTrip` EXACTLY ONCE (its
 * causation id is per trip; a retry after commit replays the stored result), ends the trip,
 * closes the manifest — which returns every packed unit to the merge board and is the
 * refit: the next manifest is packed at full HP with fresh traps and fences — and puts the
 * caravan back in town, where nothing can attack it.
 */
export async function bankTrip(client: pg.PoolClient, caravan: CaravanRow, req: DecisionRequest): Promise<BankResult> {
  await lockCaravanForResolution(client, caravan.id);
  await lockAccountForAppend(client, caravan.account_id);
  const { trip, manifest, encounter } = await lockTripForDecision(client, caravan, req);
  if (trip.end_reason === "banked") {
    if (encounter?.decision !== "banked") throw conflict("trip_banked", "this trip was banked after a different encounter");
    return replayBank(client, trip);
  }
  assertDecisionOpen(trip, manifest, encounter, req);

  const rows = await listTripEncounters(client, trip.id);
  const unbanked = unbankedCoinOf(rows);
  // The preview promised exactly this; the ledger records exactly this (GUARDRAILS §4).
  if (unbanked !== coinForEncountersSurvived(req.encounterIndex)) {
    throw new Error(`trip ${trip.id}: unbanked Coin ${unbanked} does not match the schedule for ${req.encounterIndex} survived encounters`);
  }
  const credit = await creditBankedTrip(client, { accountId: caravan.account_id, causationId: tripCausation.bankCoin(trip.id), tripId: trip.id, encountersSurvived: req.encounterIndex });
  await decideTripEncounter(client, trip.id, req.encounterIndex, "banked");
  const survivors = manifestFromJson(manifest.survivors);
  const restored = refitOf(survivors, rows.flatMap((r) => r.deaths));
  await endTrip(client, trip.id, "banked");
  await closeManifest(client, manifest.id);
  await setCaravanState(client, caravan.id, "in_town");
  const requested = coinForBankedTrip(req.encounterIndex);
  await appendEvents(client, tripCausation.banked(trip.id), [
    {
      type: "trip_banked",
      accountId: caravan.account_id,
      caravanId: caravan.id,
      payload: {
        tripId: trip.id,
        manifestId: manifest.id,
        encountersSurvived: req.encounterIndex,
        unbankedCoin: unbanked,
        deliveryBonus: TUNABLES.COIN_PER_BANKED_TRIP,
        requested,
        credited: credit.credited,
        discarded: credit.discarded,
        restored,
      },
    },
  ]);
  return { tripId: trip.id, encountersSurvived: req.encounterIndex, requested, credited: credit.credited, discarded: credit.discarded, balanceAfter: credit.balanceAfter, restored, replayed: false };
}

async function replayBank(db: Queryable, trip: TripRow): Promise<BankResult> {
  const [ev] = await listEventsByCausation(db, tripCausation.banked(trip.id));
  if (!ev) throw new Error(`trip ${trip.id} is banked but has no trip_banked event`);
  const p = ev.payload as unknown as { encountersSurvived: number; requested: number; credited: number; discarded: number; restored: BankRefit };
  return { tripId: trip.id, encountersSurvived: p.encountersSurvived, requested: p.requested, credited: p.credited, discarded: p.discarded, balanceAfter: null, restored: p.restored, replayed: true };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Read models: trip status and the bank-or-push stakes preview
// ─────────────────────────────────────────────────────────────────────────────────────────

export type TripPhase = "arranging" | "resolving" | "resolution_unavailable" | "decide" | "ended";

export interface TripEncounterView {
  index: number;
  outcome: EncounterOutcomeKind;
  depth: number;
  deaths: string[];
  coinAccrued: number;
  decision: "pushed" | "banked" | null;
}

export interface TripView {
  id: string;
  manifestId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: "banked" | "overrun" | null;
  phase: TripPhase;
  encountersResolved: number;
  /** The encounter being arranged / resolved (phase arranging / resolving), else null. */
  currentEncounter: number | null;
  job: { id: string; status: string; lastError: string | null } | null;
  /** The encounter whose bank-or-push decision is open (phase decide), else null. */
  decisionFor: number | null;
  unbankedCoin: number;
  encounters: TripEncounterView[];
}

export interface TripStatusView {
  caravan: { id: string; state: "in_town" | "on_trip" };
  cap: TripCapView;
  /** The open trip, else the caravan's most recent one, else null. */
  trip: TripView | null;
  rules: TripRules;
}

export interface TripRules {
  tripsPerHourCap: number;
  tripCapRegenMs: number;
  tripCapGate: "time";
  noRepairBetweenEncounters: true;
  restoreOnTripEnd: string;
  bankOfferedOnlyAfterSurviving: true;
  safetyBonusForPushing: false;
}

export function tripRules(): TripRules {
  return {
    tripsPerHourCap: TUNABLES.TRIPS_PER_HOUR_CAP,
    tripCapRegenMs: TUNABLES.TRIP_CAP_REGEN_MS,
    tripCapGate: "time",
    noRepairBetweenEncounters: TUNABLES.NO_REPAIR_BETWEEN_ENCOUNTERS,
    restoreOnTripEnd: TUNABLES.RESTORE_ON_TRIP_END,
    bankOfferedOnlyAfterSurviving: true,
    safetyBonusForPushing: false,
  };
}

async function latestTrip(db: Queryable, caravanId: string): Promise<TripRow | null> {
  const open = await findOpenTrip(db, caravanId);
  if (open) return open;
  const res = await db.query<TripRow>("SELECT * FROM trip WHERE caravan_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1", [caravanId]);
  return res.rows[0] ?? null;
}

async function tripView(db: Queryable, trip: TripRow): Promise<TripView> {
  const manifest = await findManifestById(db, trip.manifest_id);
  if (!manifest) throw new Error(`trip ${trip.id}: manifest missing`);
  const rows = await listTripEncounters(db, trip.id);
  const m = manifest.encounters_resolved;
  const last = rows.find((r) => r.encounter_index === m) ?? null;
  let phase: TripPhase;
  let currentEncounter: number | null = null;
  let job: TripView["job"] = null;
  let decisionFor: number | null = null;
  if (trip.ended_at) phase = "ended";
  else if (last && last.decision === null) {
    phase = "decide";
    decisionFor = m;
  } else {
    currentEncounter = m + 1;
    const j = await getJob(db, encounterJobId(trip.id, m + 1));
    if (j) job = { id: j.id, status: j.status, lastError: j.last_error };
    phase = !j ? "arranging" : j.status === "parked" ? "resolution_unavailable" : "resolving";
  }
  return {
    id: trip.id,
    manifestId: trip.manifest_id,
    startedAt: trip.started_at.toISOString(),
    endedAt: trip.ended_at ? trip.ended_at.toISOString() : null,
    endReason: trip.end_reason ?? null,
    phase,
    encountersResolved: m,
    currentEncounter,
    job,
    decisionFor,
    unbankedCoin: trip.end_reason ? 0 : unbankedCoinOf(rows),
    encounters: rows.map((r) => ({ index: r.encounter_index, outcome: r.outcome_kind, depth: r.depth_fp, deaths: r.deaths, coinAccrued: r.coin_accrued, decision: r.decision })),
  };
}

/** Trip status for the caravan. Settles a completed resolution first (lazy, idempotent). */
export async function tripStatus(pool: pg.Pool, caravan: CaravanRow, nowMs: number): Promise<TripStatusView> {
  await settleEncounter(pool, caravan);
  const live = await pool.query<CaravanRow>("SELECT * FROM caravan WHERE id = $1", [caravan.id]);
  const trip = await latestTrip(pool, caravan.id);
  return {
    caravan: { id: caravan.id, state: live.rows[0]!.state },
    cap: await readTripCap(pool, caravan.account_id, nowMs),
    trip: trip ? await tripView(pool, trip) : null,
    rules: tripRules(),
  };
}

export interface StakesUnit {
  ref: string;
  typeId: string;
  mergeLevel: number;
  hp: number;
  maxHp: number;
  /** maxHp − hp: damage carried, never repaired mid-trip. */
  damage: number;
  alive: boolean;
  diedAtEncounter: number | null;
  /** The merge level this unit drops to when it dies (one level, floored at 1; chunk 19 applies). */
  mergeLevelOnDeath: number;
}

export interface StakesPreview {
  tripId: string;
  encountersSurvived: number;
  /** True only when bank-or-push is open right now (after surviving, before deciding). */
  decisionOpen: boolean;
  decisionFor: number | null;
  /** Trip state, never in the account balance until a bank. */
  unbankedCoin: { total: number; byEncounter: { index: number; coin: number }[] };
  /** What banking now would deliver, against the account's room right now. */
  bankNow: { encounterCoin: number; deliveryBonus: number; total: number; forecast: ReturnType<typeof overflowForecast> };
  units: StakesUnit[];
  /** What being overrun at the next encounter would cost (chunk 19 applies it). */
  ifOverrun: {
    coinLost: number;
    /** Alive now: lost outright if the caravan falls. */
    unitsLostOutright: { ref: string; typeId: string; mergeLevel: number; hp: number }[];
    /** Already dead: de-merged one level, NOT destroyed. */
    unitsDeMergedNotDestroyed: { ref: string; typeId: string; mergeLevel: number; mergeLevelAfter: number }[];
  };
  traps: { remaining: { ref: string; typeId: string }[]; spent: { ref: string; typeId: string }[] };
  fences: { intact: { ref: string; tierId: string; hp: number; maxHp: number }[]; destroyed: { ref: string; tierId: string; maxHp: number }[] };
  nextEncounter: {
    index: number;
    /** Coin the next encounter is worth if survived (unbanked until a bank). */
    reward: number;
    /** Banking right after surviving it would deliver this. */
    bankTotalIfSurvived: number;
    /** Chunk 14's escalation: the band centre for the next party sits this far above your rating. */
    difficulty: { escalationApplied: number; risePerEncounter: number; harderThanThisEncounter: boolean };
    /** The next party arrives at full strength; nothing of yours is repaired or restocked. */
    partyArrivesFresh: true;
  };
  /** Chunk 14 hooks surfaced beside the stakes: the last opponent's Reputation gap and earn multiplier. */
  lastOpponent: { encounterIndex: number; reputation: Record<string, unknown> } | null;
  rules: TripRules;
}

/**
 * The bank-or-push preview (GUARDRAILS §4: stakes previewable; a loss must be foreseeable).
 * Reads the MANIFEST (never unit_instance) for every unit's level and HP. Settles a
 * completed resolution first. 404 when the caravan has no open trip.
 */
export async function stakesPreview(pool: pg.Pool, caravan: CaravanRow, nowMs: number): Promise<StakesPreview> {
  await settleEncounter(pool, caravan);
  const trip = await findOpenTrip(pool, caravan.id);
  if (!trip) throw notFound("no_trip", "this caravan is in town; nothing is at stake");
  const view = await tripView(pool, trip);
  const manifest = await findManifestById(pool, trip.manifest_id);
  const survivors = manifestFromJson(manifest!.survivors);
  const rows = await listTripEncounters(pool, trip.id);
  const diedAt = new Map<string, number>();
  for (const r of rows) for (const ref of r.deaths) diedAt.set(ref, r.encounter_index);
  const m = view.encountersResolved;
  const unbanked = unbankedCoinOf(rows);
  const bankTotal = unbanked + TUNABLES.COIN_PER_BANKED_TRIP;
  const trickle = await peekTrickle(pool, caravan.account_id, nowMs);
  const floor = TUNABLES.MERGE_LEVEL_MIN;
  const units: StakesUnit[] = survivors.units.map((u) => ({
    ref: u.ref,
    typeId: u.typeId,
    mergeLevel: u.mergeLevel,
    hp: u.hp,
    maxHp: u.maxHp,
    damage: u.maxHp - u.hp,
    alive: u.hp > 0,
    diedAtEncounter: diedAt.get(u.ref) ?? null,
    mergeLevelOnDeath: Math.max(floor, u.mergeLevel - 1),
  }));
  const chosen = m >= 1 ? await chosenCandidate(pool, trip.id, m) : null;
  const next = m + 1;
  return {
    tripId: trip.id,
    encountersSurvived: m,
    decisionOpen: view.phase === "decide",
    decisionFor: view.decisionFor,
    unbankedCoin: { total: unbanked, byEncounter: rows.map((r) => ({ index: r.encounter_index, coin: r.coin_accrued })) },
    bankNow: {
      encounterCoin: unbanked,
      deliveryBonus: TUNABLES.COIN_PER_BANKED_TRIP,
      total: bankTotal,
      // "Room right now" (chunk 16 QA N6): the trickle keeps filling the store meanwhile.
      forecast: overflowForecast(trickle.balance, trickle.cap, bankTotal),
    },
    units,
    ifOverrun: {
      coinLost: unbanked,
      unitsLostOutright: units.filter((u) => u.alive).map((u) => ({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, hp: u.hp })),
      unitsDeMergedNotDestroyed: units.filter((u) => !u.alive).map((u) => ({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, mergeLevelAfter: u.mergeLevelOnDeath })),
    },
    traps: {
      remaining: survivors.traps.filter((t) => !t.spent).map((t) => ({ ref: t.ref, typeId: t.typeId })),
      spent: survivors.traps.filter((t) => t.spent).map((t) => ({ ref: t.ref, typeId: t.typeId })),
    },
    fences: {
      intact: survivors.fences.filter((f) => f.hp > 0).map((f) => ({ ref: f.ref, tierId: f.tierId, hp: f.hp, maxHp: f.maxHp })),
      destroyed: survivors.fences.filter((f) => f.hp === 0).map((f) => ({ ref: f.ref, tierId: f.tierId, maxHp: f.maxHp })),
    },
    nextEncounter: {
      index: next,
      reward: coinForEncounter(next),
      bankTotalIfSurvived: coinForBankedTrip(next),
      difficulty: { escalationApplied: escalationFor(next), risePerEncounter: ESCALATION_PER_ENCOUNTER, harderThanThisEncounter: escalationFor(next) > (m >= 1 ? escalationFor(m) : -1) },
      partyArrivesFresh: true,
    },
    // The earn multiplier is shown as chunk 14 computed it; chunk 19's applyEarnFloor is
    // the one place it will land on Coin (not applied by chunk 15).
    lastOpponent: chosen ? { encounterIndex: m, reputation: { ...chosen.reputation } } : null,
    rules: tripRules(),
  };
}

export { findTripById };
