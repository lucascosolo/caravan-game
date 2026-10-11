/**
 * The merge system (chunk 16): what Coin is for. Two recipes from the registry
 * (2 → 1 and 5 → 3), one stronger copy of the SAME unit type, no branching, no
 * specialization, capped at level 5 for everyone (GUARDRAILS §2).
 *
 * A merged unit is NOT stronger than its components combined — it is more slot-efficient
 * (MERGE_SLOT_COST is one slot at any level). The stat curve lives in content
 * (MERGE_STAT_MULT_BY_LEVEL); this module only reads it for the preview and never applies
 * any multiplier of its own. Coin decides WHEN a merge happens, never what it produces.
 *
 * Server-validated against the caller's own instances: all on the named caravan, which
 * must belong to the account AND be in town (QA S1: units on an open trip are at risk and
 * stay at risk — nothing is repaired or merged mid-trip); same type; same level; count
 * exactly a recipe's `spend`. Everything that needs no row (ids well-formed, distinct,
 * a recipe for the count) is checked before the first query (QA N2, S3).
 *
 * Commit is one transaction under the account append lock: consume the instances, create
 * the outputs, and debit through `spendCoin` (the only debit path), which appends
 * `coin_spent` + `unit_merged` under one causation id. A retry of a merge that already
 * committed — the same caravan and the same input ids — returns the stored outcome
 * (QA S6) instead of "not owned". Two merges racing on the same instances serialize on
 * the lock; the loser is exactly such a retry.
 *
 * Conventions: a caravan that is not the caller's is a 404, the same as one that does not
 * exist (the response never confirms a foreign caravan id).
 */
import { FIXED_POINT_SCALE, TUNABLES, getUnitType, mergeStatMult, scaleInt, type LivingUnitType } from "@caravan/content";
import type pg from "pg";
import { withTransaction, type Queryable } from "../db/pool.js";
import type { CaravanState, UnitInstanceRow } from "../db/types.js";
import type { JsonObject, LedgerEventDraft, LedgerEventRow } from "../ledger/events.js";
import { causationExists, listEventsByCausation, lockAccountForAppend } from "../ledger/ledger.js";
import { partyMembership, standingPartyInvalidationDraft } from "../party/service.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { readCoinBalance, spendCoin } from "./coin.js";
import { peekTrickle } from "./trickle.js";

export interface MergeRecipe {
  readonly spend: number;
  readonly produce: number;
}

export const MERGE_RECIPES: readonly MergeRecipe[] = TUNABLES.MERGE_RECIPES;

/** The recipe that consumes exactly `count` units, or null. Count alone selects it. */
export function recipeForCount(count: number): MergeRecipe | null {
  return MERGE_RECIPES.find((r) => r.spend === count) ?? null;
}

/** Coin for a merge producing `produce` units at `targetLevel`. Cost is per resulting unit. */
export function mergeCost(targetLevel: number, produce: number): number {
  if (!Number.isInteger(targetLevel) || targetLevel <= TUNABLES.MERGE_LEVEL_MIN || targetLevel > TUNABLES.MERGE_LEVEL_MAX) {
    throw new RangeError(`target level ${String(targetLevel)} is not a merge result level`);
  }
  if (!Number.isInteger(produce) || produce < 1) throw new RangeError("produce must be a positive integer");
  const perUnit = TUNABLES.MERGE_COST_BY_TARGET_LEVEL[targetLevel];
  if (perUnit === undefined) throw new RangeError(`no merge cost for level ${targetLevel}`);
  return perUnit * produce;
}

/** The whole cost table, for the UI: {2: 250, 3: 900, ...} per resulting unit. */
export function mergeCostTable(): Record<number, number> {
  const out: Record<number, number> = {};
  for (let lvl = TUNABLES.MERGE_LEVEL_MIN + 1; lvl <= TUNABLES.MERGE_LEVEL_MAX; lvl++) out[lvl] = mergeCost(lvl, 1);
  return out;
}

export interface UnitStats {
  /** Max HP at this level: scaleInt(type.hp, mult). */
  hp: number;
  /** Ratings are NEVER scaled by merging (content: MERGE_MULT_APPLIES_TO). Shown unchanged. */
  offense: number;
  defense: number;
  /** Each hit's damage-formula output is scaled by this, as a fixed-point numerator over `multDen`. */
  damageOutputMult: number;
  multDen: number;
  /** Reference hit vs. an opponent of this type's own defense rating, after the multiplier. */
  referenceHit: number;
}

/** PROJECT.md §11 damage formula, floored: offense² / (offense + defense). Reference only. */
function referenceDamage(offense: number, defense: number): number {
  return Math.floor((offense * offense) / (offense + defense));
}

/**
 * What a unit of this type is at a merge level, by content's curve. The multiplier applies
 * to max HP and to damage OUTPUT only (never to the ratings that enter the formula, never
 * to ability fields). Informational — the resolver applies the same rule itself (chunk 11);
 * this exists so the preview shows the player exactly what they are buying.
 */
export function statsAtLevel(unit: LivingUnitType, level: number): UnitStats {
  const mult = mergeStatMult(level);
  return {
    hp: scaleInt(unit.hp, mult),
    offense: unit.offense,
    defense: unit.defense,
    damageOutputMult: mult,
    multDen: FIXED_POINT_SCALE,
    referenceHit: scaleInt(referenceDamage(unit.offense, unit.defense), mult),
  };
}

/** Combined HP and reference hit of `count` such units (ratings and multiplier are per-unit, not summed). */
function sumStats(stats: UnitStats, count: number): UnitStats {
  return { ...stats, hp: stats.hp * count, referenceHit: stats.referenceHit * count };
}

export interface MergePreview {
  caravanId: string;
  unitTypeId: string;
  unitDisplayName: string;
  recipe: MergeRecipe;
  fromLevel: number;
  toLevel: number;
  costPerUnit: number;
  totalCost: number;
  /** Ledger balance PLUS the trickle pending as of the preview — what a commit now would see (QA S2). */
  balance: number;
  /** Of `balance`, the part the trickle has accrued but not yet written. */
  pendingTrickle: number;
  affordable: boolean;
  /**
   * Chunk 09 QA S3: which of the consumed instances ride in the standing party. A merge
   * consumes them, so the party would no longer resolve until edited. The commit refuses
   * with 409 `unit_in_party` unless the request carries `confirmInParty: true`.
   */
  consumed: { instanceIds: string[]; inParty: string[]; count: number; slots: number; perUnit: UnitStats; combined: UnitStats };
  /** True when `consumed.inParty` is non-empty: the commit needs `confirmInParty: true`. */
  requiresConfirmInParty: boolean;
  produced: { count: number; slots: number; perUnit: UnitStats; combined: UnitStats };
  slotsFreed: number;
  /** Same ability, larger numbers; never a new one. */
  ability: { archetype: string; displayName: string };
}

function notFound(message: string): AppError {
  return new AppError(404, "not_found", message);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caravan id in the path, before it reaches a `uuid` column (QA S3). */
function assertCaravanId(caravanId: unknown): asserts caravanId is string {
  if (typeof caravanId !== "string" || !UUID.test(caravanId)) throw badRequest("invalid_caravan_id", "caravanId must be a uuid");
}

/**
 * Everything about the input ids that needs no database: a non-empty array of uuids,
 * normalized to lowercase (so a retry with different casing is the same cause, QA S6),
 * distinct after normalization, and a count some recipe consumes (QA N2 — a 20 000-id
 * request is refused here, not after a 20 000-id query).
 */
function normalizeInstanceIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw badRequest("invalid_instance_ids", "instanceIds must be a non-empty array of unit instance ids");
  }
  const normalized = (ids as string[]).map((id) => id.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw badRequest("duplicate_instances", "instanceIds must be distinct");
  if (!recipeForCount(normalized.length)) {
    throw badRequest(
      "no_such_recipe",
      `a merge consumes ${MERGE_RECIPES.map((r) => r.spend).join(" or ")} units of the same type and level; got ${normalized.length}`,
    );
  }
  return normalized;
}

interface ValidatedMerge {
  rows: UnitInstanceRow[];
  unit: LivingUnitType;
  recipe: MergeRecipe;
  fromLevel: number;
  toLevel: number;
  totalCost: number;
}

/** Shared by preview and commit. `rows` must already be the caller's instances on the caravan. */
function validateMergeRows(instanceIds: readonly string[], rows: readonly UnitInstanceRow[]): ValidatedMerge {
  const recipe = recipeForCount(instanceIds.length);
  if (!recipe) throw badRequest("no_such_recipe", "no recipe consumes this many units");
  if (rows.length !== instanceIds.length) {
    const have = new Set(rows.map((r) => r.id));
    const missing = instanceIds.filter((id) => !have.has(id));
    throw notFound(`unit instance(s) not owned on this caravan: ${missing.join(", ")}`);
  }
  const first = rows[0]!;
  if (rows.some((r) => r.unit_type_id !== first.unit_type_id)) {
    throw badRequest("mixed_unit_types", "all merged units must be the same type — merging never branches");
  }
  if (rows.some((r) => r.merge_level !== first.merge_level)) {
    throw badRequest("mixed_merge_levels", "all merged units must be the same merge level");
  }
  const unit = getUnitType(first.unit_type_id);
  if (!unit) throw badRequest("unknown_unit_type", `unit type '${first.unit_type_id}' is not in content`);
  const fromLevel = first.merge_level;
  const toLevel = fromLevel + 1;
  if (toLevel > TUNABLES.MERGE_LEVEL_MAX) {
    throw conflict("merge_cap", `merge cap is level ${TUNABLES.MERGE_LEVEL_MAX} for everyone; these units are already level ${fromLevel}`);
  }
  return { rows: [...rows], unit, recipe, fromLevel, toLevel, totalCost: mergeCost(toLevel, recipe.produce) };
}

function buildPreview(caravanId: string, v: ValidatedMerge, balance: number, pendingTrickle: number, inParty: readonly string[]): MergePreview {
  const perBefore = statsAtLevel(v.unit, v.fromLevel);
  const perAfter = statsAtLevel(v.unit, v.toLevel);
  return {
    caravanId,
    unitTypeId: v.unit.id,
    unitDisplayName: v.unit.displayName,
    recipe: v.recipe,
    fromLevel: v.fromLevel,
    toLevel: v.toLevel,
    costPerUnit: mergeCost(v.toLevel, 1),
    totalCost: v.totalCost,
    balance,
    pendingTrickle,
    affordable: balance >= v.totalCost,
    consumed: {
      instanceIds: v.rows.map((r) => r.id),
      inParty: [...inParty],
      count: v.recipe.spend,
      slots: v.recipe.spend * TUNABLES.MERGE_SLOT_COST,
      perUnit: perBefore,
      combined: sumStats(perBefore, v.recipe.spend),
    },
    produced: {
      count: v.recipe.produce,
      slots: v.recipe.produce * TUNABLES.MERGE_SLOT_COST,
      perUnit: perAfter,
      combined: sumStats(perAfter, v.recipe.produce),
    },
    slotsFreed: (v.recipe.spend - v.recipe.produce) * TUNABLES.MERGE_SLOT_COST,
    ability: { archetype: v.unit.ability.archetype, displayName: v.unit.ability.displayName },
    requiresConfirmInParty: inParty.length > 0,
  };
}

/**
 * The caravan must be the caller's (else 404, same as not existing). Returns its state;
 * `lock` takes FOR SHARE so a trip cannot start under an open merge transaction.
 */
async function readOwnedCaravanState(db: Queryable, accountId: string, caravanId: string, lock: boolean): Promise<CaravanState> {
  const res = await db.query<{ state: CaravanState }>(
    `SELECT state FROM caravan WHERE id = $1 AND account_id = $2${lock ? " FOR SHARE" : ""}`,
    [caravanId, accountId],
  );
  const row = res.rows[0];
  if (!row) throw notFound(`caravan ${caravanId} is not yours`);
  return row.state;
}

/** Merging is a town activity (QA S1): a caravan on a trip has its units at risk, and they stay that way. */
function assertInTown(state: CaravanState): void {
  if (state !== "in_town") throw conflict("caravan_on_trip", "units cannot be merged while the caravan is on a trip; nothing is repaired mid-trip");
}

/** Everything the player commits against, before they commit (GUARDRAILS §4). Read-only. */
export async function previewMerge(
  db: Queryable,
  input: { accountId: string; caravanId: string; instanceIds: unknown; nowMs?: number },
): Promise<MergePreview> {
  assertCaravanId(input.caravanId);
  const instanceIds = normalizeInstanceIds(input.instanceIds);
  assertInTown(await readOwnedCaravanState(db, input.accountId, input.caravanId, false));
  const rows = await db.query<UnitInstanceRow>(
    "SELECT * FROM unit_instance WHERE id = ANY($1::uuid[]) AND caravan_id = $2 ORDER BY id",
    [instanceIds, input.caravanId],
  );
  const v = validateMergeRows(instanceIds, rows.rows);
  // Read-only: the pending trickle is computed, not written, so the preview's balance is
  // the balance a commit right now would be checked against (QA S2).
  const trickle = await peekTrickle(db, input.accountId, input.nowMs ?? Date.now());
  const membership = await partyMembership(db, input.accountId, instanceIds);
  return buildPreview(input.caravanId, v, trickle.balance, trickle.pending, membership.inParty);
}

/** 409: the merge would consume a unit the standing party names, and the request did not confirm it. */
export class UnitInPartyError extends AppError {
  constructor(public readonly inParty: readonly string[]) {
    super(
      409,
      "unit_in_party",
      `${inParty.length} of these units ride in your standing party; merging them leaves the party unable to stand until you edit it. Send confirmInParty: true to merge anyway.`,
    );
    this.name = "UnitInPartyError";
  }
}

/** The `unit_merged` event payload; what a retry gets back (QA S6). */
export interface UnitMergedPayload extends JsonObject {
  unitTypeId: string;
  fromLevel: number;
  toLevel: number;
  recipe: { spend: number; produce: number };
  consumedInstanceIds: string[];
  producedInstanceIds: string[];
  coinCost: number;
}

export interface MergeResult {
  /**
   * True when this request named a merge that had already committed (same caravan, same
   * inputs): nothing moved, and `merged`, `events` and `consumedIds` are the stored ones.
   * `preview` is null and `produced` lists whichever outputs still exist on the roster.
   */
  replayed: boolean;
  preview: MergePreview | null;
  merged: UnitMergedPayload;
  produced: UnitInstanceRow[];
  producedIds: string[];
  consumedIds: string[];
  events: LedgerEventRow[];
  balanceAfter: number;
}

/** The one cause a given set of inputs can ever be merged under. Ids are lowercase and sorted. */
function mergeCausationId(caravanId: string, instanceIds: readonly string[]): string {
  return `merge:${caravanId.toLowerCase()}:${[...instanceIds].sort().join(",")}`;
}

/**
 * Commit a merge atomically. Order inside the transaction:
 *   1. account append lock (serializes every Coin movement and merge for this account)
 *   2. the caravan is the caller's (404) — then, if this exact merge already committed,
 *      return its stored outcome (QA S6)
 *   3. the caravan is in town (409 `caravan_on_trip`, QA S1), FOR SHARE for the transaction
 *   4. lock + validate the input instances (ownership, type, level, recipe, cap)
 *   5. DELETE the inputs (row count must equal `spend`), INSERT the outputs
 *   6. `spendCoin`: flush the trickle, balance >= cost else `insufficient_coin` (rolls
 *      back 5), then `coin_spent` + `unit_merged` under one deterministic causation id
 */
export async function performMerge(
  pool: pg.Pool,
  input: { accountId: string; caravanId: string; instanceIds: unknown; confirmInParty?: unknown; nowMs?: number },
): Promise<MergeResult> {
  assertCaravanId(input.caravanId);
  const instanceIds = normalizeInstanceIds(input.instanceIds);
  const caravanId = input.caravanId.toLowerCase();
  const nowMs = input.nowMs ?? Date.now();
  const consumedIds = [...instanceIds].sort();
  const causationId = mergeCausationId(caravanId, consumedIds);
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, input.accountId);
    const state = await readOwnedCaravanState(client, input.accountId, caravanId, true);
    if (await causationExists(client, causationId)) return replayMerge(client, input.accountId, caravanId, causationId);
    assertInTown(state);
    const locked = await client.query<UnitInstanceRow>(
      "SELECT * FROM unit_instance WHERE id = ANY($1::uuid[]) AND caravan_id = $2 ORDER BY id FOR UPDATE",
      [instanceIds, caravanId],
    );
    const v = validateMergeRows(instanceIds, locked.rows);
    // Chunk 09 QA S3: consuming a unit the standing party names leaves the party unable
    // to stand until edited. Read under the account append lock, which saveParty also
    // takes before reading the roster, so the answer cannot change under this merge.
    const membership = await partyMembership(client, input.accountId, instanceIds);
    if (membership.inParty.length > 0 && input.confirmInParty !== true) throw new UnitInPartyError(membership.inParty);
    const deleted = await client.query<{ id: string }>(
      "DELETE FROM unit_instance WHERE id = ANY($1::uuid[]) AND caravan_id = $2 RETURNING id",
      [instanceIds, caravanId],
    );
    if (deleted.rowCount !== v.recipe.spend) {
      throw conflict("merge_inputs_changed", "the units to merge changed underneath this request");
    }
    const produced: UnitInstanceRow[] = [];
    for (let i = 0; i < v.recipe.produce; i++) {
      const ins = await client.query<UnitInstanceRow>(
        "INSERT INTO unit_instance (caravan_id, unit_type_id, merge_level) VALUES ($1, $2, $3) RETURNING *",
        [caravanId, v.unit.id, v.toLevel],
      );
      produced.push(ins.rows[0]!);
    }
    const merged: UnitMergedPayload = {
      unitTypeId: v.unit.id,
      fromLevel: v.fromLevel,
      toLevel: v.toLevel,
      recipe: { spend: v.recipe.spend, produce: v.recipe.produce },
      consumedInstanceIds: consumedIds,
      producedInstanceIds: produced.map((p) => p.id),
      coinCost: v.totalCost,
    };
    const unitMerged: LedgerEventDraft = { type: "unit_merged", accountId: input.accountId, caravanId, payload: merged };
    // QA S3: the party now resolves without the consumed instances; record that under the
    // merge's own causation id (null when the party named none of them).
    const invalidated = await standingPartyInvalidationDraft(client, input.accountId, consumedIds, "merge");
    const spend = await spendCoin(client, input.accountId, v.totalCost, "merge", nowMs, {
      causationId,
      extra: { caravanId, unitTypeId: v.unit.id, toLevel: v.toLevel, produced: v.recipe.produce },
      alongside: invalidated ? [unitMerged, invalidated] : [unitMerged],
    });
    const preview = buildPreview(caravanId, v, spend.balanceBefore, 0, membership.inParty);
    return {
      replayed: false,
      preview,
      merged,
      produced,
      producedIds: merged.producedInstanceIds,
      consumedIds,
      events: spend.events,
      balanceAfter: spend.balanceAfter,
    };
  });
}

/** A retry of a committed merge: the stored outcome, nothing moved (QA S6). */
async function replayMerge(client: pg.PoolClient, accountId: string, caravanId: string, causationId: string): Promise<MergeResult> {
  const events = await listEventsByCausation(client, causationId);
  const mergedEvent = events.find((e) => e.event_type === "unit_merged" && e.account_id === accountId && e.caravan_id === caravanId);
  if (!mergedEvent) throw notFound("unit instance(s) not owned on this caravan");
  const merged = mergedEvent.payload as UnitMergedPayload;
  const stillThere = await client.query<UnitInstanceRow>(
    "SELECT * FROM unit_instance WHERE id = ANY($1::uuid[]) AND caravan_id = $2 ORDER BY id",
    [merged.producedInstanceIds, caravanId],
  );
  const { balance } = await readCoinBalance(client, accountId);
  return {
    replayed: true,
    preview: null,
    merged,
    produced: stillThere.rows,
    producedIds: merged.producedInstanceIds,
    consumedIds: merged.consumedInstanceIds,
    events,
    balanceAfter: balance,
  };
}
