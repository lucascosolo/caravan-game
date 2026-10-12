/**
 * STAKES AND LOSS (chunk 19). The consequences of a trip, applied exactly once, inside the
 * trip loop's own transactions (trip/service.ts calls these from `settleLocked` on an
 * overrun and from `bankTrip` on a bank — never anywhere else):
 *
 *   per death      every unit that DIED in any encounter of the trip loses one merge level,
 *                  floored at MERGE_LEVEL_MIN, when the trip ends — banked or overrun alike
 *                  (`unit_demerged_on_death`, one per death, even when the floor holds it at 1).
 *   total loss     on an overrun, every unit still ALIVE in the manifest when the caravan
 *                  falls is destroyed (`unit_lost_on_wipe`, one per instance; the instance row
 *                  is deleted). A unit that died earlier on the same trip — including in the
 *                  fight the caravan fell in — is de-merged and comes home, NOT destroyed.
 *                  This inversion is the design (chunk 19 brief): units kept safe at the back
 *                  to dodge the per-death ding are exactly the ones exposed if the caravan falls.
 *   Coin           on an overrun ALL the trip's unbanked Coin is lost (`coin_lost_on_wipe` on
 *                  the caravan; it was never in the balance, so no balance moves) and the same
 *                  amount is credited to the owner of the party at whose encounter the caravan
 *                  fell (`coin_transferred_to_party_owner`), capped by that owner's remaining
 *                  storage headroom; the excess is destroyed and recorded. The owner also earns
 *                  COIN_PER_PARTY_WIN (`coin_earned` reason `party_win`, chunk 19 QA D1) in the
 *                  same capped batch. A system (authored) owner is credited nothing — the whole
 *                  amount is destroyed, nothing minted.
 *   earn floor     `applyEarnFloor` is the ONE place chunk 14's sandbagging multiplier lands on
 *                  Coin: each survived encounter's earn is floored by the multiplier stored on
 *                  that encounter's CHOSEN candidate (`chosenEarnMultiplier`, the one reader).
 *                  It shapes what is earned; what is lost / transferred is then exactly what was
 *                  earned and unbanked — the floor is never applied a second time on a loss.
 *
 * Bounded (GUARDRAILS): everything here is keyed by the trip's own manifest refs and the
 * trip's own `trip_encounter` rows. The roster left in town, banked Coin, Reputation's
 * permanent counterparts (ladders, granted unlock points, purchased web nodes) and the
 * attacking party's owner's roster and party are never read for writing. The owner side
 * here is a single capped CREDIT, nothing else.
 *
 * Determinism (GUARDRAILS §1): no randomness and no clock. Every amount is an integer
 * function of stored rows; which instance is de-merged or destroyed is a function of the
 * manifest (alive vs dead) only.
 */
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import type { Manifest } from "@caravan/circle";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import { appendCoinCredits, coinForEncounter, partyWinCredit, type CoinCreditSpec } from "../economy/coin.js";
import type { JsonObject, LedgerEventDraft } from "../ledger/events.js";
import { assertAccountAppendLockHeld } from "../ledger/ledger.js";
import { bandOf } from "../matchmaking/band.js";
import { findChosenSearch } from "../matchmaking/service.js";
import { repairStandingParty } from "../party/service.js";
import type { TripEncounterRow } from "./repo.js";

export const DEMERGE_LEVELS_PER_DEATH: number = TUNABLES.DEMERGE_LEVELS_PER_DEATH;
export const DEMERGE_FLOOR: number = TUNABLES.MERGE_LEVEL_MIN;
// Fixed by design, asserted so nobody turns a knob the brief says does not turn.
if (DEMERGE_LEVELS_PER_DEATH !== 1) throw new Error("DEMERGE_LEVELS_PER_DEATH is fixed at 1 by design (chunk 19)");
if (TUNABLES.UNBANKED_COIN_LOST_ON_OVERRUN_BP !== 10_000) throw new Error("UNBANKED_COIN_LOST_ON_OVERRUN_BP is fixed at 100% by design (chunk 19)");

// ─────────────────────────────────────────────────────────────────────────────────────────
// The sandbagging earn floor (chunk 14 QA D2 / chunk 04 QA D2): ONE apply site.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE earn floor. `floor(coinEarned × multiplier / FIXED_ONE)`, integers only. `multiplier`
 * is fixed-point in [0, FIXED_ONE] (FIXED_ONE = paid in full). Identical for every account:
 * it takes two integers and reads nothing.
 */
export function applyEarnFloor(coinEarned: number, multiplier: number): number {
  if (!Number.isSafeInteger(coinEarned) || coinEarned < 0) throw new RangeError(`coinEarned must be a non-negative safe integer, got ${String(coinEarned)}`);
  if (!Number.isInteger(multiplier) || multiplier < 0 || multiplier > FIXED_ONE) throw new RangeError(`earn multiplier must be an integer in [0, ${FIXED_ONE}], got ${String(multiplier)}`);
  return Math.floor((coinEarned * multiplier) / FIXED_ONE);
}

/**
 * What encounter n's CHOSEN menu row fixed for its Coin, read once from the stored row —
 * what the player saw before committing, never recomputed from live ratings:
 *   - `multiplier`: the sandbagging multiplier on the chosen candidate. This is the only
 *     reader of `sandbagEarnMultiplier` outside matchmaking/ (a source scan enforces it);
 *   - `caravanRating` / `band`: the caravan's living Reputation the search was drawn at and
 *     its display band (chunk 19 QA D2a: encounter Coin scales with it). The caravan's living
 *     rating only moves when its own encounters settle, so this equals the band the preview
 *     showed for the next encounter before the push.
 */
export async function chosenEncounterTerms(db: Queryable, tripId: string, encounterIndex: number): Promise<{ multiplier: number; caravanRating: number; band: number }> {
  const row = await findChosenSearch(db, tripId, encounterIndex);
  const chosen = row ? row.candidates.find((c) => c.candidateId === row.chosen_candidate_id) : undefined;
  if (!row || !chosen) throw new Error(`trip ${tripId}: no chosen candidate for encounter ${encounterIndex}; its earn terms are unknown`);
  const m = chosen.reputation.sandbagEarnMultiplier;
  if (!Number.isInteger(m) || m < 0 || m > FIXED_ONE) throw new Error(`trip ${tripId} encounter ${encounterIndex}: stored earn multiplier ${String(m)} is out of range`);
  if (!Number.isInteger(row.caravan_rating)) throw new Error(`trip ${tripId} encounter ${encounterIndex}: stored caravan rating ${String(row.caravan_rating)} is not an integer`);
  return { multiplier: m, caravanRating: row.caravan_rating, band: bandOf(row.caravan_rating).index };
}

/** The multiplier stored on encounter n's CHOSEN candidate (see chosenEncounterTerms). */
export async function chosenEarnMultiplier(db: Queryable, tripId: string, encounterIndex: number): Promise<number> {
  return (await chosenEncounterTerms(db, tripId, encounterIndex)).multiplier;
}

/**
 * Coin a survived encounter n accrues (unbanked) for the caravan: the schedule at the
 * caravan's display band (chunk 19 QA D2a, band from the chosen menu row), through the earn
 * floor. Stored as `trip_encounter.coin_accrued` at settle; bank and overrun use the stored
 * amount, so neither a later rating move nor a retune changes it.
 */
export async function encounterEarn(db: Queryable, tripId: string, encounterIndex: number): Promise<{ scheduled: number; band: number; multiplier: number; earned: number }> {
  const terms = await chosenEncounterTerms(db, tripId, encounterIndex);
  const scheduled = coinForEncounter(encounterIndex, terms.band);
  return { scheduled, band: terms.band, multiplier: terms.multiplier, earned: applyEarnFloor(scheduled, terms.multiplier) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Per-death de-merge (bank and overrun)
// ─────────────────────────────────────────────────────────────────────────────────────────

/** The level a unit drops to for dying: one level, floored. Pure; the preview uses the same function. */
export function mergeLevelAfterDeath(level: number): number {
  return Math.max(DEMERGE_FLOOR, level - DEMERGE_LEVELS_PER_DEATH);
}

export interface DeMergedUnit extends JsonObject {
  ref: string;
  typeId: string;
  fromLevel: number;
  toLevel: number;
  diedAtEncounter: number;
}

export interface DestroyedUnit extends JsonObject {
  ref: string;
  typeId: string;
  mergeLevel: number;
  hp: number;
}

/** Encounter index at which each unit of the trip died (refs from `trip_encounter.deaths`). */
export function deathIndex(rows: readonly TripEncounterRow[]): Map<string, number> {
  const at = new Map<string, number>();
  for (const r of rows) for (const ref of r.deaths) if (!at.has(ref)) at.set(ref, r.encounter_index);
  return at;
}

/**
 * What the trip's end does to each packed unit, from the manifest alone (pure; the preview
 * and the apply step both call this, so they cannot disagree):
 *   - dead (hp 0) → de-merged one level, floored, kept;
 *   - alive → kept untouched on a bank; destroyed on an overrun.
 */
export function planUnitLosses(survivors: Manifest, rows: readonly TripEncounterRow[], end: "banked" | "overrun"): { deMerged: DeMergedUnit[]; destroyed: DestroyedUnit[] } {
  const diedAt = deathIndex(rows);
  const deMerged: DeMergedUnit[] = [];
  const destroyed: DestroyedUnit[] = [];
  for (const u of survivors.units) {
    if (u.hp === 0) {
      const at = diedAt.get(u.ref);
      if (at === undefined) throw new Error(`unit ${u.ref} is dead in the manifest but no settled encounter records its death`);
      deMerged.push({ ref: u.ref, typeId: u.typeId, fromLevel: u.mergeLevel, toLevel: mergeLevelAfterDeath(u.mergeLevel), diedAtEncounter: at });
    } else if (end === "overrun") {
      destroyed.push({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, hp: u.hp });
    }
  }
  return { deMerged, destroyed };
}

interface InstanceRow {
  id: string;
  unit_type_id: string;
  merge_level: number;
}

/**
 * Lock the trip's packed instances (FOR UPDATE, id order) and check each still is what the
 * manifest says: same caravan, same type, same level. Packed units cannot be merged or
 * otherwise removed while the manifest is open (chunk 16 S1 / chunk 17 B1), so a mismatch is
 * a broken guard — refuse rather than apply a loss the preview did not show.
 */
async function lockPacked(client: pg.PoolClient, caravanId: string, units: readonly { ref: string; typeId: string; level: number }[]): Promise<void> {
  if (units.length === 0) return;
  const ids = units.map((u) => u.ref);
  const res = await client.query<InstanceRow>(
    "SELECT id, unit_type_id, merge_level FROM unit_instance WHERE id = ANY($1::uuid[]) AND caravan_id = $2 ORDER BY id FOR UPDATE",
    [ids, caravanId],
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  for (const u of units) {
    const row = byId.get(u.ref);
    if (!row) throw new Error(`packed unit ${u.ref} is no longer on caravan ${caravanId}; a trip loss cannot be applied to it`);
    if (row.unit_type_id !== u.typeId || row.merge_level !== u.level) {
      throw new Error(`packed unit ${u.ref} changed during the trip (${row.unit_type_id} L${row.merge_level}, manifest says ${u.typeId} L${u.level})`);
    }
  }
}

/**
 * Apply the per-death de-merges in the caller's transaction and return their drafts (caravan
 * scope). One `unit_demerged_on_death` per dead unit; a unit already at the floor is recorded
 * with `fromLevel === toLevel` (the death is still a fact). Exactly once: the caller runs it
 * only in the transaction that ends the trip.
 */
export async function applyDeMerges(
  client: pg.PoolClient,
  owner: { accountId: string; caravanId: string },
  tripId: string,
  end: "banked" | "overrun",
  deMerged: readonly DeMergedUnit[],
): Promise<LedgerEventDraft[]> {
  await lockPacked(client, owner.caravanId, deMerged.map((u) => ({ ref: u.ref, typeId: u.typeId, level: u.fromLevel })));
  const drafts: LedgerEventDraft[] = [];
  for (const u of deMerged) {
    if (u.toLevel !== u.fromLevel) {
      const upd = await client.query("UPDATE unit_instance SET merge_level = $3 WHERE id = $1 AND caravan_id = $2 AND merge_level = $4", [u.ref, owner.caravanId, u.toLevel, u.fromLevel]);
      if (upd.rowCount !== 1) throw new Error(`de-merge of ${u.ref} touched ${String(upd.rowCount)} rows`);
    }
    drafts.push({
      type: "unit_demerged_on_death",
      accountId: owner.accountId,
      caravanId: owner.caravanId,
      payload: { unitInstanceId: u.ref, unitTypeId: u.typeId, fromLevel: u.fromLevel, toLevel: u.toLevel, floored: u.toLevel === u.fromLevel, diedAtEncounter: u.diedAtEncounter, tripId, tripEnd: end },
    });
  }
  return drafts;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Overrun: total loss + the Coin transfer
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface OverrunCoinOutcome extends JsonObject {
  /** All of the trip's unbanked Coin: lost by the caravan. */
  lost: number;
  /** The recipient is the party owner named by the hand-off (`partyOwnerAccountId`). */
  recipientAuthored: boolean;
  /** Credited to the recipient's balance (0 for a system owner). */
  transferred: number;
  /** Destroyed: over the recipient's headroom, or all of it for a system owner. */
  destroyed: number;
  destroyedReason: "none" | "recipient_storage_cap" | "system_owner";
  /**
   * Chunk 19 QA D1: the party-win credit (COIN_PER_PARTY_WIN) the owner earns for the overrun,
   * on top of the transfer and NOT part of `lost` (it is minted, not the caravan's Coin).
   * Appended after the transfer in the same capped batch; zero in full for a system owner.
   */
  partyWin: { amount: number; credited: number; discarded: number };
}

export interface OverrunLosses extends JsonObject {
  deMerged: DeMergedUnit[];
  destroyed: DestroyedUnit[];
  coin: OverrunCoinOutcome;
}

/** Causation id of the transfer credit on the party owner's account (one per resolution job). */
export function transferCausationId(jobId: string): string {
  return `transfer:${jobId}`;
}

/**
 * Everything an overrun costs, applied in the caller's transaction (settleLocked, which
 * already holds the caravan resolution lock and BOTH accounts' append locks, sorted). Returns
 * the caravan-side drafts for the caller to append in the `trip_overrun` batch, and the
 * summary for the hand-off payload. The owner-side transfer credit is appended here, under
 * `transfer:<jobId>` (the resolution job's own causation id belongs to the worker and is
 * replay-checked, so it cannot carry later events; the party feed joins this one by job id).
 */
export async function applyOverrunLosses(
  client: pg.PoolClient,
  input: {
    defender: { accountId: string; caravanId: string };
    tripId: string;
    encounterIndex: number;
    jobId: string;
    survivors: Manifest;
    rows: readonly TripEncounterRow[];
    unbankedCoin: number;
    partyOwnerAccountId: string;
    partyOwnerAuthored: boolean;
  },
): Promise<{ drafts: LedgerEventDraft[]; losses: OverrunLosses }> {
  const { defender, tripId } = input;
  if (input.partyOwnerAccountId === defender.accountId) throw new Error(`trip ${tripId}: a caravan cannot be overrun by its own owner's party`);
  await assertAccountAppendLockHeld(client, defender.accountId, "applyOverrunLosses");
  await assertAccountAppendLockHeld(client, input.partyOwnerAccountId, "applyOverrunLosses");
  const plan = planUnitLosses(input.survivors, input.rows, "overrun");

  // 1. Died on the trip → de-merged, kept.
  const drafts = await applyDeMerges(client, defender, tripId, "overrun", plan.deMerged);

  // 2. Alive at the collapse → destroyed.
  await lockPacked(client, defender.caravanId, plan.destroyed.map((u) => ({ ref: u.ref, typeId: u.typeId, level: u.mergeLevel })));
  if (plan.destroyed.length > 0) {
    const ids = plan.destroyed.map((u) => u.ref);
    const del = await client.query("DELETE FROM unit_instance WHERE id = ANY($1::uuid[]) AND caravan_id = $2", [ids, defender.caravanId]);
    if (del.rowCount !== ids.length) throw new Error(`overrun of trip ${tripId}: destroyed ${String(del.rowCount)} of ${ids.length} instances`);
  }
  for (const u of plan.destroyed) {
    drafts.push({
      type: "unit_lost_on_wipe",
      accountId: defender.accountId,
      caravanId: defender.caravanId,
      payload: { unitInstanceId: u.ref, unitTypeId: u.typeId, mergeLevel: u.mergeLevel, hpAtCollapse: u.hp, tripId, encounterIndex: input.encounterIndex, reason: "alive_at_overrun" },
    });
  }
  // S2 (final play-test review): the defender's OWN standing party may name a packed unit that is
  // now gone; its slot is dropped and the owner told (standing_party_repaired). The party's other
  // units are untouched, and nothing of the attacking party's is ever read for writing.
  const repaired = await repairStandingParty(client, defender.accountId, { reason: "trip_loss", removedRefs: plan.destroyed.map((u) => u.ref) });
  if (repaired) drafts.push(repaired);

  // 3. Coin: all of it lost; the same amount to the overrunning party's owner, capped. Then
  //    (chunk 19 QA D1) the owner's party-win credit, in the SAME batch under the same
  //    `transfer:<jobId>` causation, so one running clamp covers both: the transfer takes the
  //    headroom first, the party win what is left. A system owner gets neither.
  const lost = input.unbankedCoin;
  let transferred = 0;
  let destroyed = 0;
  let destroyedReason: OverrunCoinOutcome["destroyedReason"] = "none";
  const partyWin = { amount: 0, credited: 0, discarded: 0 };
  if (input.partyOwnerAuthored) {
    // PHASE-2 §25 / chunk 14: nothing is ever credited to a system account; destroy it all.
    destroyed = lost;
    if (lost > 0) destroyedReason = "system_owner";
  } else {
    const credits: CoinCreditSpec[] = [];
    if (lost > 0) credits.push({ type: "coin_transferred_to_party_owner", amount: lost, reason: "caravan_overrun", extra: { jobId: input.jobId, tripId, encounterIndex: input.encounterIndex } });
    credits.push(partyWinCredit({ tripId, encounterIndex: input.encounterIndex, jobId: input.jobId }));
    const credit = await appendCoinCredits(client, { causationId: transferCausationId(input.jobId), accountId: input.partyOwnerAccountId, credits });
    const amountOf = (i: number): number => Number(credit.rows[i]!.payload["amount"]);
    if (lost > 0) {
      transferred = amountOf(0);
      destroyed = lost - transferred;
      if (destroyed > 0) destroyedReason = "recipient_storage_cap";
    }
    partyWin.amount = credits.at(-1)!.amount;
    partyWin.credited = amountOf(credits.length - 1);
    partyWin.discarded = partyWin.amount - partyWin.credited;
  }
  if (transferred + destroyed !== lost) throw new Error(`overrun of trip ${tripId}: ${transferred} + ${destroyed} does not reconcile with ${lost} lost`);
  const coin: OverrunCoinOutcome = { lost, recipientAuthored: input.partyOwnerAuthored, transferred, destroyed, destroyedReason, partyWin };
  drafts.push({
    type: "coin_lost_on_wipe",
    accountId: defender.accountId,
    caravanId: defender.caravanId,
    payload: { amount: lost, reason: "overrun", tripId, encounterIndex: input.encounterIndex, jobId: input.jobId, transferred, destroyed, destroyedReason, recipientAuthored: input.partyOwnerAuthored },
  });
  return { drafts, losses: { deMerged: plan.deMerged, destroyed: plan.destroyed, coin } };
}
