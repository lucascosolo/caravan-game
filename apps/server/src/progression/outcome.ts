/**
 * Applying an encounter outcome to both sides' progression — the API chunks 13, 15 and 19
 * call once per resolved encounter.
 *
 * Two layers:
 *   deriveProgressionEvents  PURE. (snapshot of both sides' pool state, outcome, pools used)
 *                            → ledger event drafts. No I/O; a job handler that already
 *                            holds the state in its input can call it directly.
 *   applyEncounterOutcome    The DB wrapper: reads the live rows under the per-account
 *                            append locks, derives, appends under one causation id. Safe to
 *                            retry — a causation id that already committed returns the
 *                            committed events and appends nothing.
 *
 * What moves, and where (GUARDRAILS §5 — the split is enforced by the drafts' scopes and
 * again by the ledger's CHECK):
 *
 *   Caravan side (the player who was present)
 *     living Reputation  caravan-level  every encounter — this is the caravan's
 *                                       MATCHMAKING rating
 *     living/trap ladder                per pool fielded (LADDER_EARNING_POOLS.caravan)
 *   Party side (the owner who was not there)
 *     siege  Reputation  account-level  every encounter — the standing party is an
 *                                       account-level object, so its MATCHMAKING rating is
 *                                       the owner's account-level offense pool: siege
 *                                       ("offense Reputation, stored on the siege pool")
 *     siege  ladder                     when siege was fielded (LADDER_EARNING_POOLS.party)
 *
 *   trap Reputation NEVER MOVES (chunk 04 QA decision D1). Nothing reads it: a caravan is
 *   matched by its living rating, a party by its owner's siege rating. A visible number
 *   that never matters would violate GUARDRAILS §4, so it stays at REPUTATION_START until
 *   a reader exists. The trap LADDER still rises through use.
 *
 * The rating gap for scaling is between the two matchmaking ratings: the caravan's living
 * Reputation and the owner's siege Reputation. Both start at REPUTATION_START.
 *
 * A Reputation change whose applied delta is 0 (a rating already on the floor) writes no
 * event (chunk 04 QA N1): the ledger records movement, not the absence of it. The one event
 * that first reaches the floor carries `floored: true` and the unclamped value.
 *
 * Ladder levels and granted unlock points are never reduced by anything here: the ladder
 * fold is monotone (ladder.ts), grants are only ever positive, and the DB refuses a
 * decrease anyway. An overrun — the worst outcome — still earns LADDER_GAIN_LOSS.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import type { Pool, PoolProgressRow } from "../db/types.js";
import { canonicalJson, type Json, type LedgerEventDraft, type LedgerEventRow } from "../ledger/events.js";
import { appendEvents, listEventsByCausation, lockAccountForAppend } from "../ledger/ledger.js";
import { findCaravanById } from "../repo/caravans.js";
import { getAccountPoolProgress, getCaravanPoolProgress } from "../repo/poolProgress.js";
import { advanceLadder, LADDER_EARNING_POOLS, ladderGainFor, type EncounterOutcomeKind, type Side } from "./ladder.js";
import { applyFloor, gapScaledDelta, reputationBaseDelta, type ReputationChange } from "./reputation.js";

export const ENCOUNTER_OUTCOME_KINDS: readonly EncounterOutcomeKind[] = ["caravan_held", "caravan_overrun", "stalemate"];
const ALL_POOLS: readonly Pool[] = ["living", "trap", "siege"];

export interface PoolState {
  reputation: number;
  ladderLevel: number;
  ladderPoints: number;
}

/**
 * The pools each side can move. Shape is fixed; keys are the pool names. `caravan.trap`
 * is read for its ladder only — its reputation is carried through unchanged (D1).
 */
export interface ProgressionSnapshot {
  caravan: { living: PoolState; trap: PoolState };
  party: { siege: PoolState };
}

export interface EncounterProgressionInput {
  outcome: EncounterOutcomeKind;
  /** The defending caravan: its owner, the caravan itself, and the pools it fielded. */
  caravan: { accountId: string; caravanId: string; poolsUsed: readonly Pool[] };
  /** The standing party's owner and the pools the party fielded. */
  party: { ownerAccountId: string; poolsUsed: readonly Pool[] };
  /**
   * Chunk 15 / chunk 25 QA S8: "skip" when the party's owner is a SYSTEM account (an authored
   * cold-start party). Then no party-side event of any kind is derived — no Reputation, no
   * ladder, no unlock points on the system account — while the caravan side resolves in full
   * against the authored party's (read-only) siege rating. Omitted = "apply". The trip loop
   * reads `account.is_system` at the outcome boundary and sets this; the resolver never sees it.
   */
  partySide?: "apply" | "skip";
}

export interface PoolChangeSummary {
  pool: Pool;
  reputation?: ReputationChange;
  ladder?: { levelBefore: number; levelAfter: number; pointsDelta: number; rungsCrossed: number[]; unlockPointsGranted: number };
}

export interface ProgressionResult {
  events: LedgerEventDraft[];
  after: ProgressionSnapshot;
  summary: { caravan: PoolChangeSummary[]; party: PoolChangeSummary[] };
}

function assertPools(name: string, pools: readonly Pool[]): void {
  const seen = new Set<Pool>();
  for (const p of pools) {
    if (!ALL_POOLS.includes(p)) throw new TypeError(`${name}: unknown pool '${String(p)}'`);
    if (seen.has(p)) throw new TypeError(`${name}: pool '${p}' listed twice`);
    seen.add(p);
  }
}

export function validateProgressionInput(input: EncounterProgressionInput): void {
  if (!ENCOUNTER_OUTCOME_KINDS.includes(input.outcome)) throw new TypeError(`unknown outcome '${String(input.outcome)}'`);
  if (!input.caravan.accountId || !input.caravan.caravanId) throw new TypeError("caravan.accountId and caravan.caravanId are required");
  if (!input.party.ownerAccountId) throw new TypeError("party.ownerAccountId is required");
  if (input.partySide !== undefined && input.partySide !== "apply" && input.partySide !== "skip") throw new TypeError(`unknown partySide '${String(input.partySide)}'`);
  if (input.caravan.accountId === input.party.ownerAccountId) {
    throw new TypeError("a player never meets their own standing party; progression refuses a self-encounter");
  }
  assertPools("caravan.poolsUsed", input.caravan.poolsUsed);
  assertPools("party.poolsUsed", input.party.poolsUsed);
}

function clonePool(p: PoolState): PoolState {
  return { reputation: p.reputation, ladderLevel: p.ladderLevel, ladderPoints: p.ladderPoints };
}

/**
 * PURE. Derive every progression event for one resolved encounter. Event order is fixed
 * (caravan side then party side; within a side reputation, then ladder, then grants, pools
 * in living/trap/siege order), so the same inputs yield a byte-identical draft list.
 */
export function deriveProgressionEvents(snapshot: ProgressionSnapshot, input: EncounterProgressionInput): ProgressionResult {
  validateProgressionInput(input);
  const after: ProgressionSnapshot = {
    caravan: { living: clonePool(snapshot.caravan.living), trap: clonePool(snapshot.caravan.trap) },
    party: { siege: clonePool(snapshot.party.siege) },
  };
  const events: LedgerEventDraft[] = [];
  const summary: ProgressionResult["summary"] = { caravan: [], party: [] };

  const caravanRating = snapshot.caravan.living.reputation;
  const partyRating = snapshot.party.siege.reputation;

  const scope = (pool: Pool, side: Side): { accountId: string; caravanId?: string } => {
    const accountId = side === "caravan" ? input.caravan.accountId : input.party.ownerAccountId;
    if (pool === "living") {
      if (side !== "caravan") throw new TypeError("the passive side has no living-pool progress to move");
      return { accountId, caravanId: input.caravan.caravanId };
    }
    return { accountId };
  };

  const changeReputation = (side: Side, pool: Pool, state: PoolState): ReputationChange => {
    const self = side === "caravan" ? caravanRating : partyRating;
    const opponent = side === "caravan" ? partyRating : caravanRating;
    if (state.reputation !== self) throw new TypeError(`${pool} is not the ${side} side's matchmaking rating`);
    const base = reputationBaseDelta(side, input.outcome);
    const change = applyFloor(state.reputation, gapScaledDelta(base, self, opponent));
    state.reputation = change.after;
    if (change.delta === 0) return change; // on the floor already: nothing moved, nothing to record (N1)
    events.push({
      type: "reputation_changed",
      ...scope(pool, side),
      payload: {
        pool,
        delta: change.delta,
        reason: input.outcome,
        side,
        unclamped: change.unclamped,
        floored: change.floored,
        selfRating: self,
        opponentRating: opponent,
      },
    });
    return change;
  };

  const gainLadder = (side: Side, pool: Pool, state: PoolState): PoolChangeSummary["ladder"] | undefined => {
    const adv = advanceLadder({ level: state.ladderLevel, points: state.ladderPoints }, ladderGainFor(side, input.outcome));
    if (adv.pointsDelta === 0 && adv.rungsCrossed.length === 0) return undefined; // capped: nothing owed
    state.ladderLevel = adv.after.level;
    state.ladderPoints = adv.after.points;
    events.push({
      type: "ladder_progress_gained",
      ...scope(pool, side),
      payload: {
        pool,
        pointsDelta: adv.pointsDelta,
        levelsGained: adv.rungsCrossed.length,
        side,
        outcome: input.outcome,
        levelBefore: adv.before.level,
        levelAfter: adv.after.level,
      },
    });
    let granted = 0;
    adv.rungsCrossed.forEach((rung, i) => {
      const points = adv.unlockPointsPerRung[i]!;
      granted += points;
      events.push({ type: "unlock_points_granted", ...scope(pool, side), payload: { pool, points, rung } });
    });
    return {
      levelBefore: adv.before.level,
      levelAfter: adv.after.level,
      pointsDelta: adv.pointsDelta,
      rungsCrossed: adv.rungsCrossed,
      unlockPointsGranted: granted,
    };
  };

  // ── Caravan side ────────────────────────────────────────────────────────────────────
  {
    const used = new Set(input.caravan.poolsUsed);
    const living: PoolChangeSummary = { pool: "living" };
    living.reputation = changeReputation("caravan", "living", after.caravan.living); // always: the matchmaking rating
    const trap: PoolChangeSummary = { pool: "trap" }; // ladder only; trap Reputation never moves (D1)
    for (const pool of LADDER_EARNING_POOLS.caravan) {
      if (!used.has(pool)) continue;
      const state = pool === "living" ? after.caravan.living : after.caravan.trap;
      const ladder = gainLadder("caravan", pool, state);
      if (ladder) (pool === "living" ? living : trap).ladder = ladder;
    }
    summary.caravan.push(living);
    if (trap.ladder) summary.caravan.push(trap);
  }

  // ── Party side ──────────────────────────────────────────────────────────────────────
  if (input.partySide !== "skip") {
    const used = new Set(input.party.poolsUsed);
    const siege: PoolChangeSummary = { pool: "siege" };
    siege.reputation = changeReputation("party", "siege", after.party.siege); // always: the party's matchmaking rating
    for (const pool of LADDER_EARNING_POOLS.party) {
      if (!used.has(pool)) continue;
      const ladder = gainLadder("party", pool, after.party.siege);
      if (ladder) siege.ladder = ladder;
    }
    summary.party.push(siege);
  }

  return { events, after, summary };
}

// ---------------------------------------------------------------------------------------
// Database layer
// ---------------------------------------------------------------------------------------

export function poolStateOf(row: PoolProgressRow): PoolState {
  return { reputation: row.reputation, ladderLevel: row.ladder_level, ladderPoints: row.ladder_points };
}

/** The causation id progression events for a resolution job are written under. */
export function progressionCausationId(jobId: string): string {
  return `progression:${jobId}`;
}

/**
 * A stable digest of an encounter input (pools in canonical order), stored on every event
 * the input produced as `payload.inputHash`. A retry under the same causation id must
 * carry the same input; a different one is a caller bug and is refused rather than
 * silently answered with the first input's events (chunk 04 QA S3).
 */
export function progressionInputHash(input: EncounterProgressionInput): string {
  const canonical: Json = {
    outcome: input.outcome,
    caravan: { accountId: input.caravan.accountId, caravanId: input.caravan.caravanId, poolsUsed: [...input.caravan.poolsUsed].sort() },
    party: { ownerAccountId: input.party.ownerAccountId, poolsUsed: [...input.party.poolsUsed].sort() },
    // Only present when skipped, so every hash written before chunk 15 is unchanged.
    ...(input.partySide === "skip" ? { partySide: "skip" } : {}),
  };
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

export class ProgressionCausationMismatch extends Error {
  constructor(causationId: string) {
    super(`causation id '${causationId}' was already applied with a different encounter input`);
    this.name = "ProgressionCausationMismatch";
  }
}

/**
 * Refuse to run outside an explicit transaction (chunk 04 QA N2). The append locks are
 * transaction-scoped: on an autocommit client they would be released after the statement
 * that took them, and the read-derive-append sequence would race. Detection: force an xid
 * in one statement, then ask for it in the next — on an autocommit connection the first
 * statement's transaction has already ended, so the second sees none.
 */
export async function assertInTransaction(client: pg.PoolClient): Promise<void> {
  await client.query("SELECT pg_current_xact_id()");
  const res = await client.query<{ xid: string | null }>("SELECT pg_current_xact_id_if_assigned()::text AS xid");
  if (res.rows[0]?.xid == null) {
    throw new Error("applyEncounterOutcome must run inside an explicit transaction (BEGIN … COMMIT); the append locks are transaction-scoped");
  }
}

/** Read both sides' live pool state. Verifies the caravan belongs to the account named. */
export async function readProgressionSnapshot(db: Queryable, input: EncounterProgressionInput): Promise<ProgressionSnapshot> {
  const caravan = await findCaravanById(db, input.caravan.caravanId);
  if (!caravan) throw new Error(`caravan ${input.caravan.caravanId} not found`);
  if (caravan.account_id !== input.caravan.accountId) {
    throw new Error(`caravan ${input.caravan.caravanId} does not belong to account ${input.caravan.accountId}`);
  }
  const living = await getCaravanPoolProgress(db, input.caravan.caravanId);
  const trap = await getAccountPoolProgress(db, input.caravan.accountId, "trap");
  const siege = await getAccountPoolProgress(db, input.party.ownerAccountId, "siege");
  if (!living) throw new Error(`caravan ${input.caravan.caravanId} has no living-pool progress row`);
  if (!trap) throw new Error(`account ${input.caravan.accountId} has no trap-pool progress row`);
  if (!siege) throw new Error(`account ${input.party.ownerAccountId} has no siege-pool progress row`);
  return { caravan: { living: poolStateOf(living), trap: poolStateOf(trap) }, party: { siege: poolStateOf(siege) } };
}

export interface ApplyOutcomeResult {
  /** False when this causation id had already committed; `events` are then the stored rows. */
  created: boolean;
  events: LedgerEventRow[];
  result: ProgressionResult | null;
}

/**
 * Apply one encounter's outcome to both sides, inside the caller's transaction. Takes the
 * per-account append locks (sorted) BEFORE reading, so the read state is exactly what the
 * appended events fold onto, even with other resolutions racing on either account.
 * Idempotent on `causationId`.
 */
export async function applyEncounterOutcome(
  client: pg.PoolClient,
  causationId: string,
  input: EncounterProgressionInput,
): Promise<ApplyOutcomeResult> {
  validateProgressionInput(input);
  await assertInTransaction(client);
  const inputHash = progressionInputHash(input);
  for (const id of [input.caravan.accountId, input.party.ownerAccountId].sort()) await lockAccountForAppend(client, id);
  const prior = await listEventsByCausation(client, causationId);
  if (prior.length > 0) {
    if (prior.some((e) => e.payload["inputHash"] !== inputHash)) throw new ProgressionCausationMismatch(causationId);
    return { created: false, events: prior, result: null };
  }
  const snapshot = await readProgressionSnapshot(client, input);
  const result = deriveProgressionEvents(snapshot, input);
  const drafts = result.events.map((e) => ({ ...e, payload: { ...e.payload, inputHash } }));
  const events = await appendEvents(client, causationId, drafts);
  return { created: true, events, result };
}
