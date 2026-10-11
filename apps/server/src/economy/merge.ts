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
 * must belong to the account; same type; same level; count exactly a recipe's `spend`.
 * Commit is one transaction under the account append lock: consume the instances, create
 * the outputs, and append `coin_spent` + `unit_merged`. Two merges racing on the same
 * instances serialize on the lock and the loser finds its inputs gone.
 */
import { FIXED_POINT_SCALE, TUNABLES, getUnitType, mergeStatMult, scaleInt, type LivingUnitType } from "@caravan/content";
import type pg from "pg";
import { withTransaction, type Queryable } from "../db/pool.js";
import type { UnitInstanceRow } from "../db/types.js";
import { coinDebitDraft } from "../ledger/coin.js";
import type { LedgerEventDraft, LedgerEventRow } from "../ledger/events.js";
import { appendEvents, lockAccountForAppend } from "../ledger/ledger.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { accrueTrickleTx } from "./trickle.js";

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
  balance: number;
  affordable: boolean;
  consumed: { instanceIds: string[]; count: number; slots: number; perUnit: UnitStats; combined: UnitStats };
  produced: { count: number; slots: number; perUnit: UnitStats; combined: UnitStats };
  slotsFreed: number;
  /** Same ability, larger numbers; never a new one. */
  ability: { archetype: string; displayName: string };
}

function notFound(message: string): AppError {
  return new AppError(404, "not_found", message);
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
  const distinct = new Set(instanceIds);
  if (distinct.size !== instanceIds.length) throw badRequest("duplicate_instances", "instanceIds must be distinct");
  const recipe = recipeForCount(instanceIds.length);
  if (!recipe) {
    throw badRequest(
      "no_such_recipe",
      `a merge consumes ${MERGE_RECIPES.map((r) => r.spend).join(" or ")} units of the same type and level; got ${instanceIds.length}`,
    );
  }
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

function buildPreview(caravanId: string, v: ValidatedMerge, balance: number): MergePreview {
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
    affordable: balance >= v.totalCost,
    consumed: {
      instanceIds: v.rows.map((r) => r.id),
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
  };
}

async function assertCaravanOwned(db: Queryable, accountId: string, caravanId: string): Promise<void> {
  const res = await db.query("SELECT 1 FROM caravan WHERE id = $1 AND account_id = $2", [caravanId, accountId]);
  if ((res.rowCount ?? 0) === 0) throw notFound(`caravan ${caravanId} is not yours`);
}

function assertUuidList(ids: unknown): asserts ids is string[] {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw badRequest("invalid_instance_ids", "instanceIds must be a non-empty array of unit instance ids");
  }
}

/** Everything the player commits against, before they commit (GUARDRAILS §4). Read-only. */
export async function previewMerge(
  db: Queryable,
  input: { accountId: string; caravanId: string; instanceIds: unknown },
): Promise<MergePreview> {
  assertUuidList(input.instanceIds);
  await assertCaravanOwned(db, input.accountId, input.caravanId);
  const rows = await db.query<UnitInstanceRow>(
    "SELECT * FROM unit_instance WHERE id = ANY($1::uuid[]) AND caravan_id = $2 ORDER BY id",
    [input.instanceIds, input.caravanId],
  );
  const v = validateMergeRows(input.instanceIds, rows.rows);
  const acct = await db.query<{ coin_balance: number }>("SELECT coin_balance FROM account WHERE id = $1", [input.accountId]);
  return buildPreview(input.caravanId, v, acct.rows[0]?.coin_balance ?? 0);
}

export interface MergeResult {
  preview: MergePreview;
  produced: UnitInstanceRow[];
  consumedIds: string[];
  events: LedgerEventRow[];
  balanceAfter: number;
}

/**
 * Commit a merge atomically. Order inside the transaction:
 *   1. account append lock (serializes every Coin movement and merge for this account)
 *   2. trickle accrual, so the balance checked is the balance the player sees
 *   3. lock + validate the input instances (ownership, type, level, recipe, cap)
 *   4. balance >= cost, else `insufficient_coin` (the CHECK is the backstop)
 *   5. DELETE the inputs (row count must equal `spend`), INSERT the outputs
 *   6. append `coin_spent` and `unit_merged` under one deterministic causation id
 */
export async function performMerge(
  pool: pg.Pool,
  input: { accountId: string; caravanId: string; instanceIds: unknown; nowMs?: number },
): Promise<MergeResult> {
  assertUuidList(input.instanceIds);
  const instanceIds = input.instanceIds;
  return withTransaction(pool, async (client) => {
    await lockAccountForAppend(client, input.accountId);
    await assertCaravanOwned(client, input.accountId, input.caravanId);
    const trickle = await accrueTrickleTx(client, input.accountId, input.nowMs ?? Date.now());
    const locked = await client.query<UnitInstanceRow>(
      "SELECT * FROM unit_instance WHERE id = ANY($1::uuid[]) AND caravan_id = $2 ORDER BY id FOR UPDATE",
      [instanceIds, input.caravanId],
    );
    const v = validateMergeRows(instanceIds, locked.rows);
    const preview = buildPreview(input.caravanId, v, trickle.balance);
    if (!preview.affordable) {
      throw conflict("insufficient_coin", `merge to level ${v.toLevel} costs ${v.totalCost} Coin; balance is ${trickle.balance}`);
    }
    const deleted = await client.query<{ id: string }>(
      "DELETE FROM unit_instance WHERE id = ANY($1::uuid[]) AND caravan_id = $2 RETURNING id",
      [instanceIds, input.caravanId],
    );
    if (deleted.rowCount !== v.recipe.spend) {
      throw conflict("merge_inputs_changed", "the units to merge changed underneath this request");
    }
    const produced: UnitInstanceRow[] = [];
    for (let i = 0; i < v.recipe.produce; i++) {
      const ins = await client.query<UnitInstanceRow>(
        "INSERT INTO unit_instance (caravan_id, unit_type_id, merge_level) VALUES ($1, $2, $3) RETURNING *",
        [input.caravanId, v.unit.id, v.toLevel],
      );
      produced.push(ins.rows[0]!);
    }
    const consumedIds = [...instanceIds].sort();
    const causationId = `merge:${input.caravanId}:${consumedIds.join(",")}`;
    const drafts: LedgerEventDraft[] = [
      coinDebitDraft({
        accountId: input.accountId,
        amount: v.totalCost,
        reason: "merge",
        extra: { caravanId: input.caravanId, unitTypeId: v.unit.id, toLevel: v.toLevel, produced: v.recipe.produce },
      }),
      {
        type: "unit_merged",
        accountId: input.accountId,
        caravanId: input.caravanId,
        payload: {
          unitTypeId: v.unit.id,
          fromLevel: v.fromLevel,
          toLevel: v.toLevel,
          recipe: { spend: v.recipe.spend, produce: v.recipe.produce },
          consumedInstanceIds: consumedIds,
          producedInstanceIds: produced.map((p) => p.id),
          coinCost: v.totalCost,
        },
      },
    ];
    const events = await appendEvents(client, causationId, drafts);
    return { preview, produced, consumedIds, events, balanceAfter: trickle.balance - v.totalCost };
  });
}
