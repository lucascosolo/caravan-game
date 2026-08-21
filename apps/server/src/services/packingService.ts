import { TUNABLES, hasAccess, findLivingUnitType, findTrapType } from "@caravan/content";
import type { UnlockedAccess } from "@caravan/content";
import type { UnitInstance, Caravan } from "../domain/account.js";
import type { UnitInstanceRepository, AccessRepository } from "../repo/inMemory.js";
import type { IdGenerator } from "../domain/ids.js";

export class PackingValidationError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`Packing invalid: ${reasons.join("; ")}`);
    this.name = "PackingValidationError";
  }
}

export class CaravanNotFoundError extends Error {
  constructor(caravanId: string) {
    super(`Caravan ${caravanId} not found`);
    this.name = "CaravanNotFoundError";
  }
}

export interface PackedLivingUnit {
  readonly unitInstanceId: string;
}

export interface PackedTrap {
  readonly trapTypeId: string;
}

export interface Manifest {
  readonly livingUnits: readonly PackedLivingUnit[];
  readonly traps: readonly PackedTrap[];
  readonly fenceMaterialBudget: number;
}

export interface PackInput {
  readonly caravanId: string;
  readonly livingUnitInstanceIds: readonly string[];
  readonly trapTypeIds: readonly string[];
  readonly fenceMaterialBudget: number;
}

export interface PackOutput {
  readonly manifest: Manifest;
}

/**
 * Orchestrates packing a caravan for a trip and managing caravan state
 * transitions (TOWN-04, chunk 17). The manifest is locked once the trip
 * starts — no additions, swaps, or restock mid-trail. Enforced server-side.
 *
 * Only unlocked types are selectable; only instances actually in the roster
 * can be packed.
 */
export class PackingService {
  constructor(
    private readonly unitRepo: UnitInstanceRepository,
    private readonly accessRepo: AccessRepository,
    private readonly idGen: IdGenerator,
  ) {}

  /**
   * Validate and create a packed manifest. Collects every violation before
   * throwing.
   */
  pack(input: PackInput, caravanId: string, accountId: string, access?: UnlockedAccess): Manifest {
    const reasons: string[] = [];
    const unlocked = access ?? this.accessRepo.getForAccount(accountId);

    // --- Living units ------------------------------------------------------
    if (input.livingUnitInstanceIds.length > TUNABLES.DEPLOYMENT_SLOT_CAP) {
      reasons.push(
        `living units ${input.livingUnitInstanceIds.length} exceed DEPLOYMENT_SLOT_CAP ${TUNABLES.DEPLOYMENT_SLOT_CAP}`,
      );
    }

    const packedUnits: PackedLivingUnit[] = [];
    const seenUnitIds = new Set<string>();
    for (const uid of input.livingUnitInstanceIds) {
      if (seenUnitIds.has(uid)) {
        reasons.push(`duplicate unit instance ${uid}`);
        continue;
      }
      seenUnitIds.add(uid);

      const instance = this.unitRepo.get(uid);
      if (!instance) {
        reasons.push(`unit instance ${uid} does not exist`);
        continue;
      }
      if (instance.caravanId !== caravanId) {
        reasons.push(`unit instance ${uid} does not belong to caravan ${caravanId}`);
        continue;
      }

      const type = findLivingUnitType(instance.typeId);
      if (!type) {
        reasons.push(`unknown unit type ${instance.typeId}`);
        continue;
      }
      if (!hasAccess(unlocked, "living_unit", type.id)) {
        reasons.push(`unit type ${type.id} is not unlocked`);
        continue;
      }

      packedUnits.push({ unitInstanceId: uid });
    }

    // --- Traps -------------------------------------------------------------
    if (input.trapTypeIds.length > TUNABLES.TRAP_SLOT_CAP) {
      reasons.push(`traps ${input.trapTypeIds.length} exceed TRAP_SLOT_CAP ${TUNABLES.TRAP_SLOT_CAP}`);
    }

    const packedTraps: PackedTrap[] = [];
    for (const tid of input.trapTypeIds) {
      const trapType = findTrapType(tid);
      if (!trapType) {
        reasons.push(`unknown trap type ${tid}`);
        continue;
      }
      if (!hasAccess(unlocked, "trap", trapType.id)) {
        reasons.push(`trap type ${trapType.id} is not unlocked`);
        continue;
      }
      packedTraps.push({ trapTypeId: tid });
    }

    // --- Fence material ----------------------------------------------------
    if (input.fenceMaterialBudget > TUNABLES.FENCE_MATERIAL_BUDGET) {
      reasons.push(
        `fence material ${input.fenceMaterialBudget} exceeds FENCE_MATERIAL_BUDGET ${TUNABLES.FENCE_MATERIAL_BUDGET}`,
      );
    }
    if (input.fenceMaterialBudget < 0) {
      reasons.push(`fence material cannot be negative`);
    }

    if (reasons.length > 0) {
      throw new PackingValidationError(reasons);
    }

    return {
      livingUnits: packedUnits,
      traps: packedTraps,
      fenceMaterialBudget: input.fenceMaterialBudget,
    };
  }

  /**
   * Caravan state transitions (in-memory stub — real chunk 01 would have
   * a CaravanRepository for this). Stored as a simple record for now.
   */
  private caravanStates = new Map<string, { state: "in_town" | "on_trip"; manifest: Manifest | null }>();

  private requireCaravan(caravanId: string) {
    const state = this.caravanStates.get(caravanId);
    if (!state) throw new CaravanNotFoundError(caravanId);
    return state;
  }

  initCaravan(caravanId: string): void {
    this.caravanStates.set(caravanId, { state: "in_town", manifest: null });
  }

  getCaravanState(caravanId: string): "in_town" | "on_trip" {
    const state = this.caravanStates.get(caravanId);
    if (!state) throw new CaravanNotFoundError(caravanId);
    return state.state;
  }

  /**
   * Lock the manifest and depart on a trip. Sets caravan state to "on_trip".
   * Throws if already on a trip or the manifest is empty.
   */
  depart(caravanId: string, manifest: Manifest, now: string): { causationId: string; manifestId: string } {
    const state = this.requireCaravan(caravanId);
    if (state.state === "on_trip") {
      throw new PackingValidationError(["caravan is already on a trip"]);
    }
    if (manifest.livingUnits.length === 0) {
      throw new PackingValidationError(["cannot depart with no living units packed"]);
    }
    const manifestId = this.idGen.next("manifest");
    this.caravanStates.set(caravanId, { state: "on_trip", manifest });
    return { causationId: manifestId, manifestId };
  }

  /** Return the caravan to town. */
  returnToTown(caravanId: string): void {
    const state = this.requireCaravan(caravanId);
    this.caravanStates.set(caravanId, { state: "in_town", manifest: null });
  }

  /** Get the current locked manifest (null if in town). */
  getManifest(caravanId: string): Manifest | null {
    const state = this.caravanStates.get(caravanId);
    if (!state) throw new CaravanNotFoundError(caravanId);
    return state.manifest;
  }
}