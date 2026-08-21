import { TUNABLES, findLivingUnitType } from "@caravan/content";
import {
  mergeRecipeSpec,
  mergeCostForTargetLevel,
  statsAtLevel,
  type MergeRecipeKind,
  type StatBlock,
} from "@caravan/content";
import type { UnitInstance } from "../domain/account.js";
import type { CoinService } from "./coinService.js";
import type { UnitInstanceRepository } from "../repo/inMemory.js";
import type { IdGenerator } from "../domain/ids.js";

export class MergeValidationError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`Merge invalid: ${reasons.join("; ")}`);
    this.name = "MergeValidationError";
  }
}

export class CaravanNotFoundError extends Error {
  constructor(caravanId: string) {
    super(`Caravan ${caravanId} not found`);
    this.name = "CaravanNotFoundError";
  }
}

export interface MergeInput {
  readonly caravanId: string;
  readonly consumedUnitInstanceIds: readonly string[];
  readonly recipe: MergeRecipeKind;
}

export interface MergeOutput {
  readonly consumedUnitInstances: readonly UnitInstance[];
  readonly producedUnitInstances: readonly UnitInstance[];
  readonly targetLevel: number;
  readonly coinCost: number;
  readonly causationId: string;
}

export interface MergePreview {
  readonly targetLevel: number;
  readonly coinCost: number;
  readonly componentStats: StatBlock;
  readonly resultStats: StatBlock;
  readonly consumeCount: number;
  readonly produceCount: number;
  readonly componentBaseStats: StatBlock;
}

/**
 * Orchestrates unit merging on the home town merge board.
 *
 * Validation collects every violation before throwing, so a caller can
 * surface the complete picture (GUARDRAILS.md #4, legibility).
 *
 * Merge discipline (GUARDRAILS.md #2 / chunk 16):
 * - Two recipes: 2→1 (small) and 5→3 (large)
 * - Level cap at 5; a level-5 unit cannot be merged further
 * - Same type AND same level across all consumed units
 * - Costs Coin (escalating per target level)
 * - A merged unit is NEVER stronger than its components combined
 *   (enforced by MERGE_STAT_MULT_PER_LEVEL < 2000, tested separately)
 * - Slot efficiency: resulting unit(s) cost 1 slot regardless of level
 */
export class MergeService {
  constructor(
    private readonly unitRepo: UnitInstanceRepository,
    private readonly coinService: CoinService,
    private readonly idGen: IdGenerator,
  ) {}

  /** Validate a merge without executing it. Returns a preview; throws on violation. */
  preview(input: MergeInput): MergePreview {
    const { caravanId, consumedUnitInstanceIds, recipe } = input;
    const spec = mergeRecipeSpec(recipe);
    const reasons: string[] = [];

    // Count check
    if (consumedUnitInstanceIds.length !== spec.consumeCount) {
      reasons.push(
        `recipe ${recipe} requires exactly ${spec.consumeCount} units, got ${consumedUnitInstanceIds.length}`,
      );
    }

    // Fetch and validate all instances
    const instances: UnitInstance[] = [];
    for (const uid of consumedUnitInstanceIds) {
      const instance = this.unitRepo.get(uid);
      if (!instance) {
        reasons.push(`unit instance ${uid} does not exist`);
      } else if (instance.caravanId !== caravanId) {
        reasons.push(`unit instance ${uid} does not belong to caravan ${caravanId}`);
      } else {
        instances.push(instance);
      }
    }

    if (instances.length !== spec.consumeCount) {
      throw new MergeValidationError(reasons);
    }

    // Same type
    const typeId = instances[0]!.typeId;
    for (const inst of instances) {
      if (inst.typeId !== typeId) {
        reasons.push(`mixed unit types: ${typeId} vs ${inst.typeId}`);
      }
    }

    // Same level
    const fromLevel = instances[0]!.mergeLevel;
    for (const inst of instances) {
      if (inst.mergeLevel !== fromLevel) {
        reasons.push(`mixed unit levels: level ${fromLevel} vs ${inst.mergeLevel}`);
      }
    }

    const targetLevel = fromLevel + 1;

    // Level cap
    if (targetLevel > TUNABLES.MERGE_LEVEL_CAP) {
      reasons.push(
        `target level ${targetLevel} exceeds MERGE_LEVEL_CAP ${TUNABLES.MERGE_LEVEL_CAP}`,
      );
    }

    // Type validity
    const type = findLivingUnitType(typeId);
    if (!type) {
      reasons.push(`unknown unit type ${typeId}`);
    }

    if (reasons.length > 0) {
      throw new MergeValidationError(reasons);
    }

    const baseStats: StatBlock = { offense: type!.offense, defense: type!.defense, hp: type!.hp };
    const coinCost = mergeCostForTargetLevel(targetLevel);

    return {
      targetLevel,
      coinCost,
      componentStats: statsAtLevel(baseStats, fromLevel),
      resultStats: statsAtLevel(baseStats, targetLevel),
      componentBaseStats: baseStats,
      consumeCount: spec.consumeCount,
      produceCount: spec.produceCount,
    };
  }

  /**
   * Execute a merge: consume units, charge Coin, produce output units.
   * Re-validates everything server-side before applying any mutation.
   */
  execute(input: MergeInput, accountId: string, now: string): MergeOutput {
    const { caravanId, consumedUnitInstanceIds, recipe } = input;
    const spec = mergeRecipeSpec(recipe);
    const reasons: string[] = [];

    if (consumedUnitInstanceIds.length !== spec.consumeCount) {
      reasons.push(
        `recipe ${recipe} requires exactly ${spec.consumeCount} units, got ${consumedUnitInstanceIds.length}`,
      );
    }

    const instances: UnitInstance[] = [];
    for (const uid of consumedUnitInstanceIds) {
      const instance = this.unitRepo.get(uid);
      if (!instance) {
        reasons.push(`unit instance ${uid} does not exist`);
      } else if (instance.caravanId !== caravanId) {
        reasons.push(`unit instance ${uid} does not belong to caravan ${caravanId}`);
      } else {
        instances.push(instance);
      }
    }

    if (instances.length !== spec.consumeCount) {
      throw new MergeValidationError(reasons);
    }

    const typeId = instances[0]!.typeId;
    const fromLevel = instances[0]!.mergeLevel;
    for (const inst of instances) {
      if (inst.typeId !== typeId) reasons.push("mixed unit types");
      if (inst.mergeLevel !== fromLevel) reasons.push("mixed unit levels");
    }

    const targetLevel = fromLevel + 1;
    if (targetLevel > TUNABLES.MERGE_LEVEL_CAP) {
      reasons.push(`target level ${targetLevel} exceeds cap`);
    }

    const type = findLivingUnitType(typeId);
    if (!type) reasons.push(`unknown unit type ${typeId}`);
    if (reasons.length > 0) throw new MergeValidationError(reasons);

    // Coin check & debit
    const coinCost = mergeCostForTargetLevel(targetLevel);
    const causationId = this.idGen.next("merge");
    try {
      this.coinService.debit(accountId, coinCost, "merge", causationId, now);
    } catch (e) {
      if (e instanceof Error && e.name === "InsufficientCoinError") {
        reasons.push(String(e.message));
      } else {
        throw e;
      }
    }
    if (reasons.length > 0) throw new MergeValidationError(reasons);

    // Consume unit instances
    const consumedInstances: UnitInstance[] = [];
    for (const inst of instances) {
      consumedInstances.push(inst);
      this.unitRepo.delete(inst.id);
    }

    // Produce output unit instances
    const producedInstances: UnitInstance[] = [];
    for (let i = 0; i < spec.produceCount; i++) {
      const newInstance: UnitInstance = {
        id: this.idGen.next("unit"),
        caravanId,
        typeId,
        mergeLevel: targetLevel,
      };
      this.unitRepo.save(newInstance);
      producedInstances.push(newInstance);
    }

    return {
      consumedUnitInstances: consumedInstances,
      producedUnitInstances: producedInstances,
      targetLevel,
      coinCost,
      causationId,
    };
  }
}