/**
 * Matchmaking & scouting service (chunk 14): who attacks the caravan at each encounter.
 *
 * THIS IS NOT PLAYER PAIRING. The player being served is the DEFENDER; what is picked is
 * the standing party (a template, always available, its owner never present) that will
 * attack them. Nothing here reads whether an owner is online, busy or away, their region,
 * or how their build compares — all of that is intentional diversity (GUARDRAILS §0).
 *
 *   searchCandidates   draw CANDIDATES_PER_SEARCH parties banded by Reputation around the
 *                      escalated centre, snapshot each ONCE, store the menu with everything
 *                      needed to replay it. Free; a repeat for the same encounter is gated
 *                      only by REROLL_COOLDOWN_SECONDS. There is no Coin path.
 *   readCandidates     the current menu (every candidate scoutable in full) and its status.
 *   chooseCandidate    commit to one candidate: marks the menu row chosen. No live
 *                      re-resolve — the stored snapshot IS the party that will be fought.
 *   enqueueChosenEncounter
 *                      the seam chunk 15 calls after commitFormation: hands the chosen
 *                      snapshot to enqueueEncounterResolution's input path, byte-identical.
 *
 * SNAPSHOT CONTRACT (chunk 09 QA blocker, implemented here):
 *   (a) snapshotStandingParty runs exactly once per candidate, at menu generation; the
 *       StandingPartySnapshot is stored on the candidate row.
 *   (b) the scout view is scoutParty(partyFromJson(snapshot.composition)) from that stored
 *       snapshot — never a live resolve — so preview, scout and resolver input agree.
 *   (c) enqueueEncounterResolution receives that snapshot via `party` (required since QA
 *       S1: there is no live re-resolve path at commit at all).
 *   (d) StandingPartyInvalidError can only surface at generation: the party is skipped
 *       (recorded in skipped_party_ids) and another is drawn.
 *   (e) the snapshot is a copy: the owner editing, merging or losing units between
 *       selection and resolution never affects that fight.
 */
import { partyFromJson, scoutParty, serializeParty, type PartyScoutView } from "@caravan/circle";
import { createHash } from "node:crypto";
import type pg from "pg";
import { findOpenManifest } from "../circle/repo.js";
import type { Queryable } from "../db/pool.js";
import type { CaravanRow, ResolutionJobRow } from "../db/types.js";
import { enqueueEncounterResolution } from "../jobs/handlers/encounterResolution.js";
import { StandingPartyInvalidError, snapshotStandingParty, type StandingPartySnapshot } from "../jobs/snapshots.js";
import { canonicalJson, type Json, type JsonObject } from "../ledger/events.js";
import { getCaravanPoolProgress } from "../repo/poolProgress.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import {
  AUTHORED_PARTY_MAX_SHARE_BP,
  BAND_SPAN,
  CANDIDATES_PER_SEARCH,
  DIFFICULTY_ESCALATION_BP,
  ESCALATION_PER_ENCOUNTER,
  RECENT_OPPONENT_EXCLUSION,
  REPUTATION_BAND_WIDEN_STEP,
  REPUTATION_BAND_WIDTH,
  REPUTATION_BAND_WIDTH_MAX,
  REROLL_COOLDOWN_SECONDS,
  bandOf,
  bandWidths,
  candidateSeed,
  currentDrawRules,
  escalatedCentre,
  escalationFor,
  gapBeyondBand,
  replayPool,
  sandbagEarnMultiplier,
  selectCandidates,
  type AuthoredDrawRules,
  type AuthoredServedShare,
  type BandInfo,
  type PoolEntry,
  type SelectionPass,
} from "./band.js";
import { authoredOutfitFor } from "./authored.js";
import { authoredServedShare } from "./authoredShare.js";
import { noLinkedAccounts, type LinkedAccountsResolver } from "./exclusions.js";
import { findOpenTrip, type TripRow } from "./trips.js";
import { assertPushedPast } from "../trip/repo.js";

export const notFound = (code: string, message: string) => new AppError(404, code, message);

/**
 * One offered candidate AS STORED on the menu row: everything the defender can read before
 * committing (GUARDRAILS §4) plus the owner's account id — on `owner` and inside the
 * snapshot — which chunk 15 / the resolution job need and the client view omits (chunk 14
 * QA N4, chunk 25 QA D4; `CandidateView`). Account ids are not public.
 */
export interface Candidate {
  /** Stable within the menu it belongs to; what `choose` names. */
  candidateId: string;
  partyId: string;
  /**
   * `displayName`: the username of a live owner; for an authored (system) owner the
   * outfit's name, never the `sys_outfit_*` handle (chunk 25 QA N3). `flavor`: the
   * outfit's one-line flavour for an authored owner (onboarding copy, chunk 24), null for
   * a live one.
   */
  owner: { accountId: string; displayName: string; authored: boolean; flavor: string | null };
  reputation: {
    /** The owner's siege Reputation at search time (chunk 04 QA D1). */
    rating: number;
    band: BandInfo;
    /** caravan living − party siege. Positive = the party is weaker than the caravan. */
    gapFromCaravan: number;
    /**
     * max(0, gapFromCaravan − band_width_used): the part of the gap the player can be held
     * to (QA S3). Zero for every party served from inside the band the search widened to.
     */
    gapBeyondBand: number;
    /** Fixed-point multiplier on this encounter's Coin earn (sandbagging floor), from gapBeyondBand; chunk 19 applies it. */
    sandbagEarnMultiplier: number;
  };
  /** The frozen party: what the resolver will fight. */
  snapshot: StandingPartySnapshot;
  /** scoutParty(partyFromJson(snapshot.composition)): every unit, stat, ability, stance, siege and entry edge. */
  scout: PartyScoutView;
}

/** The snapshot as the client sees it: the stored snapshot without `ownerAccountId` (chunk 25 QA D4). */
export interface SnapshotView extends JsonObject {
  partyId: string;
  slot: number;
  savedAt: string;
  hash: string;
  composition: JsonObject;
}

/**
 * A candidate as the client sees it: the stored candidate with NO account id anywhere —
 * not on `owner` (chunk 14 QA N4) and not inside the snapshot (chunk 25 QA D4). The stored
 * row and the job input keep both.
 */
export type CandidateView = Omit<Candidate, "owner" | "snapshot"> & {
  owner: { displayName: string; authored: boolean; flavor: string | null };
  snapshot: SnapshotView;
};

export function candidateView(c: Candidate): CandidateView {
  const { owner, snapshot, ...rest } = c;
  const { ownerAccountId: _ownerAccountId, ...snapshotView } = snapshot;
  return { ...rest, owner: { displayName: owner.displayName, authored: owner.authored, flavor: owner.flavor ?? null }, snapshot: snapshotView };
}

/**
 * What the defender sees as the owner's name (chunk 25 QA N3): a live owner's username; an
 * authored owner's outfit name and flavour, looked up from the system username — never the
 * raw `sys_outfit_*` handle. A system account the current set no longer describes reads as
 * a generic name rather than leaking its handle.
 */
export function ownerDisplay(username: string, authored: boolean): { displayName: string; flavor: string | null } {
  if (!authored) return { displayName: username, flavor: null };
  const outfit = authoredOutfitFor(username);
  return outfit ? { displayName: outfit.name, flavor: outfit.flavor } : { displayName: "Unnamed outfit", flavor: null };
}

export interface EncounterCandidatesRow {
  trip_id: string;
  encounter_index: number;
  search_seq: number;
  seed: number;
  caravan_rating: number;
  centre: number;
  band_width_used: number;
  pool: PoolEntry[];
  excluded_party_ids: string[];
  skipped_party_ids: string[];
  candidates: Candidate[];
  searched_at_ms: number;
  /** Chunk 25: the band's authored served share the draw saw (null on rows older than migration 011). */
  authored_served: AuthoredServedShare | null;
  /** Chunk 25 QA S4: the display band of `centre` (what the served-share query keys on). */
  band: number | null;
  /** Chunk 25 QA N2: the authored-draw tunables the menu was drawn under (null = rows older than 011). */
  draw_rules: AuthoredDrawRules | null;
  /** Chunk 25 QA N2/S3: whether the served-share weight changed this draw. */
  authored_weighted_down: boolean | null;
  chosen_candidate_id: string | null;
  chosen_at: Date | null;
  created_at: Date;
}

export interface MatchmakingRules {
  candidatesPerSearch: number;
  band: { width: number; widenStep: number; max: number; widths: number[]; span: number };
  /** The reroll is free and gated by time only. There is no other gate of any kind. */
  reroll: { gate: "time"; cooldownSeconds: number };
  selfExcluded: true;
  recentOpponentsExcluded: number;
  escalation: { perEncounter: number; basisPointsOfSpan: number };
  emptyPool: "widen_then_authored";
  seed: string;
}

export function matchmakingRules(): MatchmakingRules {
  return {
    candidatesPerSearch: CANDIDATES_PER_SEARCH,
    band: { width: REPUTATION_BAND_WIDTH, widenStep: REPUTATION_BAND_WIDEN_STEP, max: REPUTATION_BAND_WIDTH_MAX, widths: bandWidths(), span: BAND_SPAN },
    reroll: { gate: "time", cooldownSeconds: REROLL_COOLDOWN_SECONDS },
    selfExcluded: true,
    recentOpponentsExcluded: RECENT_OPPONENT_EXCLUSION,
    escalation: { perEncounter: ESCALATION_PER_ENCOUNTER, basisPointsOfSpan: DIFFICULTY_ESCALATION_BP },
    emptyPool: "widen_then_authored",
    seed: "fnv1a32(caravanId:tripId:encounterIndex:searchSeq)",
  };
}

export interface CandidateMenuView {
  tripId: string;
  encounterIndex: number;
  searchSeq: number;
  seed: number;
  caravan: { rating: number; ratingPool: "living"; band: BandInfo };
  /** The band centre the draw used: caravan rating + escalation for this encounter index. */
  centre: number;
  escalation: { applied: number; perEncounter: number; nextEncounter: number };
  bandWidthUsed: number;
  widened: boolean;
  /** True when the menu needed authored parties from OUTSIDE the widest band (EMPTY_POOL_BEHAVIOR's last step). */
  authoredOutsideBand: boolean;
  /** How much of this menu is authored (PHASE-2 §25), against the cap the draw applies. */
  authoredShare: { authored: number; of: number; shareBp: number; maxShareBp: number };
  /** Chunk 25: the band's authored served share at search time, and whether it weighted authored parties down. */
  authoredServed: (AuthoredServedShare & { weightedDown: boolean }) | null;
  passes: SelectionPass[];
  excludedPartyIds: string[];
  /** Without owner account ids; skipped (invalid-at-generation) party ids stay on the row only (QA N4). */
  candidates: CandidateView[];
  searchedAtMs: number;
  reroll: { gate: "time"; cooldownSeconds: number; availableAtMs: number; available: boolean };
  chosen: { candidateId: string; chosenAt: string } | null;
  rules: MatchmakingRules;
}

export interface SearchOptions {
  /** Wall clock, supplied by the caller (routes pass Date.now()); never read here. */
  nowMs: number;
  /** PHASE-2 §31 seam: accounts excluded like self. Defaults to none. */
  linkedAccounts?: LinkedAccountsResolver;
}

interface PoolRow {
  party_id: string;
  owner_account_id: string;
  username: string;
  is_system: boolean;
  reputation: number;
}

/**
 * Every standing party the draw could possibly serve for this centre, with its owner's
 * siege Reputation. Region is NOT read. A party with no units is not served (there would
 * be nothing to fight); v1 serves slot 0. Chunk 14 QA S2 / chunk 25 QA S5: the scan is
 * bounded in SQL to what `selectCandidates` can ever pick, as a UNION ALL of two indexed
 * branches — live parties within ±REPUTATION_BAND_WIDTH_MAX of the centre (over
 * `pool_progress (pool, reputation)`, migration 009) and the system accounts' parties (the
 * outside-band fallback; over `account_system_idx`, migration 011) — so neither branch
 * reads the whole party table. Each branch drives from its index and reaches the other
 * rows by key through LATERAL ... LIMIT 1 lookups (the LIMIT keeps the planner from
 * flattening them into a hash join over a full scan). A test EXPLAINs it over ~10k parties.
 */
export const POOL_SQL = `SELECT sp.id AS party_id, pp.account_id AS owner_account_id, a.username, false AS is_system, pp.reputation
       FROM pool_progress pp
       CROSS JOIN LATERAL (SELECT username, is_system FROM account WHERE id = pp.account_id LIMIT 1) a
       CROSS JOIN LATERAL (SELECT id, composition FROM standing_party WHERE account_id = pp.account_id AND slot = 0 LIMIT 1) sp
      WHERE pp.pool = 'siege'
        AND pp.reputation BETWEEN $2::integer - $3::integer AND $2::integer + $3::integer
        AND NOT a.is_system
        AND jsonb_array_length(sp.composition -> 'units') > 0
        AND NOT (pp.account_id = ANY($1::uuid[]))
     UNION ALL
     SELECT sp.id, a.id, a.username, true, pp.reputation
       FROM account a
       CROSS JOIN LATERAL (SELECT reputation FROM pool_progress WHERE account_id = a.id AND pool = 'siege' LIMIT 1) pp
       CROSS JOIN LATERAL (SELECT id, composition FROM standing_party WHERE account_id = a.id AND slot = 0 LIMIT 1) sp
      WHERE a.is_system
        AND jsonb_array_length(sp.composition -> 'units') > 0
        AND NOT (a.id = ANY($1::uuid[]))
      ORDER BY 1`;

async function loadPool(db: Queryable, centre: number, excludeAccountIds: readonly string[]): Promise<PoolRow[]> {
  const res = await db.query<PoolRow>(POOL_SQL, [excludeAccountIds, centre, REPUTATION_BAND_WIDTH_MAX]);
  return res.rows;
}

/** The last RECENT_OPPONENT_EXCLUSION parties this ACCOUNT committed to, newest first, across all its caravans and trips. */
export async function recentOpponentPartyIds(db: Queryable, accountId: string, limit: number = RECENT_OPPONENT_EXCLUSION): Promise<string[]> {
  if (limit <= 0) return [];
  const res = await db.query<{ party_id: string }>(
    `SELECT c ->> 'partyId' AS party_id
       FROM encounter_candidates ec
       JOIN trip t ON t.id = ec.trip_id
       JOIN caravan cv ON cv.id = t.caravan_id
       CROSS JOIN LATERAL jsonb_array_elements(ec.candidates) c
      WHERE cv.account_id = $1 AND ec.chosen_at IS NOT NULL AND c ->> 'candidateId' = ec.chosen_candidate_id
      ORDER BY ec.chosen_at DESC, ec.trip_id, ec.encounter_index DESC
      LIMIT $2`,
    [accountId, limit],
  );
  return res.rows.map((r) => r.party_id);
}

function requireNextEncounter(manifest: { encounters_resolved: number; closed_at: Date | null }, encounterIndex: number): void {
  if (!Number.isInteger(encounterIndex) || encounterIndex < 1) throw badRequest("bad_encounter", "encounter index must be a positive integer");
  if (manifest.closed_at) throw conflict("manifest_closed", "this trip has ended");
  const next = manifest.encounters_resolved + 1;
  if (encounterIndex !== next) throw conflict("wrong_encounter", `the caravan is at encounter ${next}, not ${encounterIndex}`);
}

async function openTripFor(client: Queryable, caravan: CaravanRow, forUpdate: boolean): Promise<{ trip: TripRow; manifest: { encounters_resolved: number; closed_at: Date | null } }> {
  const trip = await findOpenTrip(client, caravan.id, forUpdate);
  if (!trip) throw notFound("no_trip", "this caravan is in town; nothing to search for");
  const manifest = await findOpenManifest(client, caravan.id);
  if (!manifest || manifest.id !== trip.manifest_id) throw conflict("manifest_closed", "this trip's manifest is closed");
  return { trip, manifest };
}

export async function findLatestSearch(db: Queryable, tripId: string, encounterIndex: number): Promise<EncounterCandidatesRow | null> {
  const res = await db.query<EncounterCandidatesRow>(
    "SELECT * FROM encounter_candidates WHERE trip_id = $1 AND encounter_index = $2 ORDER BY search_seq DESC LIMIT 1",
    [tripId, encounterIndex],
  );
  return res.rows[0] ?? null;
}

export async function findChosenSearch(db: Queryable, tripId: string, encounterIndex: number): Promise<EncounterCandidatesRow | null> {
  const res = await db.query<EncounterCandidatesRow>(
    "SELECT * FROM encounter_candidates WHERE trip_id = $1 AND encounter_index = $2 AND chosen_at IS NOT NULL",
    [tripId, encounterIndex],
  );
  return res.rows[0] ?? null;
}

export function candidateIdFor(tripId: string, encounterIndex: number, searchSeq: number, snapshot: StandingPartySnapshot): string {
  return createHash("sha256").update(`${tripId}:${encounterIndex}:${searchSeq}:${snapshot.partyId}:${snapshot.hash}:${snapshot.savedAt}`, "utf8").digest("hex").slice(0, 32);
}

/** Build the candidate from the stored snapshot: the scout view is derived from it and nothing else. */
export function candidateFromSnapshot(
  ids: { tripId: string; encounterIndex: number; searchSeq: number },
  entry: PoolEntry,
  who: { displayName: string; flavor: string | null },
  caravanRating: number,
  bandWidthUsed: number,
  snapshot: StandingPartySnapshot,
): Candidate {
  const gap = caravanRating - entry.rating;
  const beyond = gapBeyondBand(gap, bandWidthUsed);
  return {
    candidateId: candidateIdFor(ids.tripId, ids.encounterIndex, ids.searchSeq, snapshot),
    partyId: entry.partyId,
    owner: { accountId: entry.ownerAccountId, displayName: who.displayName, authored: entry.authored, flavor: who.flavor },
    reputation: { rating: entry.rating, band: bandOf(entry.rating), gapFromCaravan: gap, gapBeyondBand: beyond, sandbagEarnMultiplier: sandbagEarnMultiplier(beyond) },
    snapshot,
    scout: scoutParty(partyFromJson(snapshot.composition)),
  };
}

function menuView(row: EncounterCandidatesRow, passes: SelectionPass[], authoredOutsideBand: boolean, authoredWeightedDown: boolean): CandidateMenuView {
  const availableAtMs = row.searched_at_ms + REROLL_COOLDOWN_SECONDS * 1000;
  const authored = row.candidates.filter((c) => c.owner.authored).length;
  const of = row.candidates.length;
  return {
    tripId: row.trip_id,
    encounterIndex: row.encounter_index,
    searchSeq: row.search_seq,
    seed: row.seed,
    caravan: { rating: row.caravan_rating, ratingPool: "living", band: bandOf(row.caravan_rating) },
    centre: row.centre,
    escalation: { applied: row.centre - row.caravan_rating, perEncounter: ESCALATION_PER_ENCOUNTER, nextEncounter: escalationFor(row.encounter_index + 1) },
    bandWidthUsed: row.band_width_used,
    widened: row.band_width_used > REPUTATION_BAND_WIDTH,
    authoredOutsideBand,
    authoredShare: { authored, of, shareBp: of === 0 ? 0 : Math.floor((authored * 10_000) / of), maxShareBp: AUTHORED_PARTY_MAX_SHARE_BP },
    authoredServed: row.authored_served ? { ...row.authored_served, weightedDown: row.authored_weighted_down ?? authoredWeightedDown } : null,
    passes,
    excludedPartyIds: row.excluded_party_ids,
    candidates: row.candidates.map(candidateView),
    searchedAtMs: row.searched_at_ms,
    reroll: { gate: "time", cooldownSeconds: REROLL_COOLDOWN_SECONDS, availableAtMs, available: false },
    chosen: row.chosen_at ? { candidateId: row.chosen_candidate_id!, chosenAt: row.chosen_at.toISOString() } : null,
    rules: matchmakingRules(),
  };
}

/** Re-run the stored draw to get the passes/fallback flags (and, for QA, to prove the menu replays). */
export function replaySearch(row: EncounterCandidatesRow): { partyIds: string[]; passes: SelectionPass[]; usedAuthoredFallback: boolean; authoredWeightedDown: boolean; bandWidthUsed: number } {
  const r = selectCandidates({ centre: row.centre, seed: row.seed, pool: row.pool, skipped: new Set(row.skipped_party_ids), authoredServed: row.authored_served, rules: row.draw_rules });
  return { partyIds: r.picks.map((p) => p.partyId), passes: r.passes, usedAuthoredFallback: r.usedAuthoredFallback, authoredWeightedDown: r.authoredWeightedDown, bandWidthUsed: r.bandWidthUsed };
}

function viewOf(row: EncounterCandidatesRow, nowMs: number): CandidateMenuView {
  const replay = replaySearch(row);
  const v = menuView(row, replay.passes, replay.usedAuthoredFallback, replay.authoredWeightedDown);
  v.reroll.available = v.chosen === null && nowMs >= v.reroll.availableAtMs;
  return v;
}

/** Thrown when even the authored fallback cannot fill a menu: the database holds too few parties. */
export class PoolEmptyError extends AppError {
  constructor(found: number) {
    super(503, "pool_empty", `only ${found} servable part${found === 1 ? "y" : "ies"} exist; ${CANDIDATES_PER_SEARCH} are needed — seed the authored parties (pnpm db:seed)`);
    this.name = "PoolEmptyError";
  }
}

export class RerollCooldownError extends AppError {
  constructor(
    public readonly availableAtMs: number,
    public readonly retryAfterSeconds: number,
  ) {
    super(409, "reroll_cooldown", `searching again is free in ${retryAfterSeconds}s; there is no way to shorten the wait`);
    this.name = "RerollCooldownError";
  }
}

/**
 * Search (or search again) for encounter `encounterIndex` of the caravan's open trip.
 * Inside the caller's transaction; locks the trip row so searches and the choose step for
 * one trip are serialized. The first search of an encounter is immediate; each later one
 * is free but waits REROLL_COOLDOWN_SECONDS after the previous. Refused once a candidate
 * for this encounter has been chosen.
 */
export async function searchCandidates(client: pg.PoolClient, caravan: CaravanRow, encounterIndex: number, opts: SearchOptions): Promise<CandidateMenuView> {
  if (!Number.isInteger(opts.nowMs) || opts.nowMs < 0) throw new RangeError("nowMs must be a non-negative integer");
  const { trip, manifest } = await openTripFor(client, caravan, true);
  requireNextEncounter(manifest, encounterIndex);
  // Chunk 15: the next attacker is served only after the player chose to PUSH past the
  // encounter they just survived — scouting it is not a free peek before bank-or-push.
  await assertPushedPast(client, trip.id, encounterIndex);
  if (await findChosenSearch(client, trip.id, encounterIndex)) throw conflict("already_chosen", "a candidate for this encounter is already chosen; arrange the circle against it");
  const latest = await findLatestSearch(client, trip.id, encounterIndex);
  if (latest) {
    const availableAtMs = latest.searched_at_ms + REROLL_COOLDOWN_SECONDS * 1000;
    if (opts.nowMs < availableAtMs) throw new RerollCooldownError(availableAtMs, Math.ceil((availableAtMs - opts.nowMs) / 1000));
  }
  const searchSeq = (latest?.search_seq ?? 0) + 1;

  const progress = await getCaravanPoolProgress(client, caravan.id);
  if (!progress) throw new Error(`caravan ${caravan.id} has no living pool progress`);
  const caravanRating = progress.reputation;
  const centre = escalatedCentre(caravanRating, encounterIndex);
  const seed = candidateSeed(caravan.id, trip.id, encounterIndex, searchSeq);

  // Exclusions: self (always), linked accounts (seam), the account's recent opponents.
  const linked = await (opts.linkedAccounts ?? noLinkedAccounts)(client, caravan.account_id);
  const excludedAccounts = [caravan.account_id, ...linked];
  const recent = await recentOpponentPartyIds(client, caravan.account_id);
  const rows = await loadPool(client, centre, excludedAccounts);
  const recentSet = new Set(recent);
  const pool: PoolEntry[] = [];
  const excludedPartyIds: string[] = [];
  for (const r of rows) {
    if (recentSet.has(r.party_id)) excludedPartyIds.push(r.party_id);
    else pool.push({ partyId: r.party_id, ownerAccountId: r.owner_account_id, rating: r.reputation, authored: r.is_system });
  }
  const names = new Map(rows.map((r) => [r.party_id, ownerDisplay(r.username, r.is_system)]));
  // Chunk 25: the band's authored served share (second stage of retire-by-ratio), and the
  // draw rules in force, both stored with the menu so the draw replays from the row (QA N2).
  const band = bandOf(centre);
  const authoredServed = await authoredServedShare(client, band);
  const rules = currentDrawRules();

  // Draw, snapshotting each pick exactly once; a party that no longer resolves is skipped
  // (recorded) and the draw re-runs without it, so the stored inputs replay to the stored menu.
  const skipped = new Set<string>();
  const snapshots = new Map<string, StandingPartySnapshot>();
  let result = selectCandidates({ centre, seed, pool, skipped, authoredServed, rules });
  for (;;) {
    let retry = false;
    for (const pick of result.picks) {
      if (snapshots.has(pick.partyId)) continue;
      try {
        snapshots.set(pick.partyId, await snapshotStandingParty(client, pick.ownerAccountId));
      } catch (err) {
        if (!(err instanceof StandingPartyInvalidError)) throw err;
        skipped.add(pick.partyId);
        retry = true;
      }
    }
    if (!retry) break;
    result = selectCandidates({ centre, seed, pool, skipped, authoredServed, rules });
  }
  if (result.picks.length < CANDIDATES_PER_SEARCH) throw new PoolEmptyError(result.picks.length);

  // QA S5: store only what the draw could have picked — everything within the width it
  // ended at, the fallback's candidates, and the skipped — and prove it replays before writing.
  const stored = replayPool(pool, centre, result, skipped);
  const check = selectCandidates({ centre, seed, pool: stored, skipped, authoredServed, rules });
  if (check.picks.map((p) => p.partyId).join() !== result.picks.map((p) => p.partyId).join() || check.bandWidthUsed !== result.bandWidthUsed) {
    throw new Error("stored pool subset does not replay to the drawn menu");
  }

  const ids = { tripId: trip.id, encounterIndex, searchSeq };
  const candidates = result.picks.map((p) => {
    const who = names.get(p.partyId) ?? { displayName: "", flavor: null };
    return candidateFromSnapshot(ids, p, who, caravanRating, result.bandWidthUsed, snapshots.get(p.partyId)!);
  });
  const res = await client.query<EncounterCandidatesRow>(
    `INSERT INTO encounter_candidates (trip_id, encounter_index, search_seq, seed, caravan_rating, centre, band_width_used, pool, excluded_party_ids, skipped_party_ids, candidates, searched_at_ms, authored_served, band, draw_rules, authored_weighted_down)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15::jsonb, $16) RETURNING *`,
    [trip.id, encounterIndex, searchSeq, seed, caravanRating, centre, result.bandWidthUsed, JSON.stringify(stored), JSON.stringify(excludedPartyIds), JSON.stringify([...skipped]), canonicalJson(candidates as unknown as Json), opts.nowMs, JSON.stringify(authoredServed), band.index, JSON.stringify(rules), result.authoredWeightedDown],
  );
  return viewOf(res.rows[0]!, opts.nowMs);
}

/** The current menu for the encounter (the latest search; the chosen one, if any, is always the latest). */
export async function readCandidates(db: Queryable, caravan: CaravanRow, encounterIndex: number, nowMs: number): Promise<CandidateMenuView> {
  const { trip } = await openTripFor(db, caravan, false);
  if (!Number.isInteger(encounterIndex) || encounterIndex < 1) throw badRequest("bad_encounter", "encounter index must be a positive integer");
  const row = (await findChosenSearch(db, trip.id, encounterIndex)) ?? (await findLatestSearch(db, trip.id, encounterIndex));
  if (!row) throw notFound("no_search", `no candidates have been searched for encounter ${encounterIndex}`);
  return viewOf(row, nowMs);
}

export interface ChoiceView {
  menu: CandidateMenuView;
  chosen: CandidateView;
}

/**
 * Commit to a candidate of the CURRENT menu. Marks the row chosen; the stored snapshot is
 * what will be fought, exactly as scouted — no live re-resolve, so the owner editing or
 * losing units since the search changes nothing (contract (c)/(e)). Idempotent for the
 * same candidate; a different one once chosen is `already_chosen`. A candidate id from an
 * earlier (rerolled-away) menu is `stale_candidate`: the player re-reads the current menu.
 */
export async function chooseCandidate(client: pg.PoolClient, caravan: CaravanRow, encounterIndex: number, candidateId: string, nowMs: number): Promise<ChoiceView> {
  if (typeof candidateId !== "string" || !/^[0-9a-f]{32}$/.test(candidateId)) throw badRequest("bad_candidate", "candidateId must be the id of an offered candidate");
  const { trip, manifest } = await openTripFor(client, caravan, true);
  requireNextEncounter(manifest, encounterIndex);
  const chosen = await findChosenSearch(client, trip.id, encounterIndex);
  if (chosen) {
    if (chosen.chosen_candidate_id === candidateId) return { menu: viewOf(chosen, nowMs), chosen: candidateView(chosen.candidates.find((c) => c.candidateId === candidateId)!) };
    throw conflict("already_chosen", "a different candidate for this encounter is already chosen");
  }
  const latest = await findLatestSearch(client, trip.id, encounterIndex);
  if (!latest) throw notFound("no_search", `no candidates have been searched for encounter ${encounterIndex}`);
  const candidate = latest.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate) {
    const older = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM encounter_candidates WHERE trip_id = $1 AND encounter_index = $2 AND candidates @> jsonb_build_array(jsonb_build_object('candidateId', $3::text))",
      [trip.id, encounterIndex, candidateId],
    );
    if (Number(older.rows[0]!.n) > 0) throw conflict("stale_candidate", "that candidate was on an earlier menu; a later search replaced it — read the current candidates");
    throw notFound("unknown_candidate", "no such candidate on the current menu");
  }
  const res = await client.query<EncounterCandidatesRow>(
    "UPDATE encounter_candidates SET chosen_candidate_id = $4, chosen_at = now() WHERE trip_id = $1 AND encounter_index = $2 AND search_seq = $3 RETURNING *",
    [trip.id, encounterIndex, latest.search_seq, candidateId],
  );
  return { menu: viewOf(res.rows[0]!, nowMs), chosen: candidateView(candidate) };
}

/** The chosen candidate for an encounter of a trip (row shape: owner account id included), or null. Chunk 15 reads this; the client reads `readCandidates`. */
export async function chosenCandidate(db: Queryable, tripId: string, encounterIndex: number): Promise<Candidate | null> {
  const row = await findChosenSearch(db, tripId, encounterIndex);
  if (!row) return null;
  return row.candidates.find((c) => c.candidateId === row.chosen_candidate_id) ?? null;
}

/**
 * THE SEAM FOR CHUNK 15: after commitFormation, queue the encounter's resolution with the
 * CHOSEN snapshot as the party input. enqueueEncounterResolution stores it as-is; a test
 * proves job.input.party is byte-identical to the candidate's snapshot and that
 * scoutParty over it is byte-identical to what the defender was shown.
 */
export async function enqueueChosenEncounter(
  client: pg.PoolClient,
  caravan: CaravanRow,
  encounterIndex: number,
  formation: JsonObject,
): Promise<{ job: ResolutionJobRow; created: boolean; candidate: Candidate }> {
  const { trip } = await openTripFor(client, caravan, true);
  const candidate = await chosenCandidate(client, trip.id, encounterIndex);
  if (!candidate) throw conflict("no_candidate_chosen", `no candidate is chosen for encounter ${encounterIndex}; search and choose first`);
  // Self-check: the stored snapshot still parses and serializes to itself (it is canonical).
  const party = partyFromJson(candidate.snapshot.composition);
  if (canonicalJson(JSON.parse(serializeParty(party))) !== canonicalJson(candidate.snapshot.composition)) throw new Error("stored party snapshot is not canonical");
  const { job, created } = await enqueueEncounterResolution(client, {
    tripId: trip.id,
    encounterIndex,
    defenderAccountId: caravan.account_id,
    defenderCaravanId: caravan.id,
    partyOwnerAccountId: candidate.owner.accountId,
    formation,
    party: candidate.snapshot,
  });
  return { job, created, candidate };
}
