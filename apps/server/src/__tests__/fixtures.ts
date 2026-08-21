import { LIVING_UNIT_TYPES, SIEGE_TYPES, type UnlockedAccess } from "@caravan/content";
import { CountingIdGenerator } from "../domain/ids.js";
import type { UnitInstance } from "../domain/account.js";
import {
  InMemoryAccessRepository,
  InMemoryReplayRepository,
  InMemoryResolutionRecordRepository,
  InMemoryStandingPartyRepository,
  InMemoryUnitInstanceRepository,
} from "../repo/inMemory.js";
import { StandingPartyService } from "../services/standingPartyService.js";

export const ACCOUNT_ID = "acc_1";
export const CARAVAN_ID = "car_1";

export function fullAccess(): UnlockedAccess {
  return {
    livingUnitTypeIds: new Set(LIVING_UNIT_TYPES.map((t) => t.id)),
    siegeTypeIds: new Set(SIEGE_TYPES.map((t) => t.id)),
    trapTypeIds: new Set(),
  };
}

export function buildHarness(opts: { unitCount?: number; access?: UnlockedAccess } = {}) {
  const unitCount = opts.unitCount ?? 4;
  const access = opts.access ?? fullAccess();

  const partyRepo = new InMemoryStandingPartyRepository();
  const unitRepo = new InMemoryUnitInstanceRepository();
  const replayRepo = new InMemoryReplayRepository();
  const resolutionRepo = new InMemoryResolutionRecordRepository();
  const accessRepo = new InMemoryAccessRepository();
  accessRepo.grant(ACCOUNT_ID, access);
  const idGen = new CountingIdGenerator();

  const unitInstances: UnitInstance[] = [];
  for (let i = 0; i < unitCount; i++) {
    const type = LIVING_UNIT_TYPES[i % LIVING_UNIT_TYPES.length]!;
    const instance: UnitInstance = {
      id: `unit_${i}`,
      caravanId: CARAVAN_ID,
      typeId: type.id,
      mergeLevel: 1,
    };
    unitInstances.push(instance);
    unitRepo.save(instance);
  }

  const service = new StandingPartyService(partyRepo, unitRepo, replayRepo, resolutionRepo, accessRepo, idGen);
  const ownedCaravanIds = new Set([CARAVAN_ID]);

  return { service, partyRepo, unitRepo, replayRepo, resolutionRepo, accessRepo, idGen, unitInstances, ownedCaravanIds };
}

export function cell(x: number, y: number) {
  return { x, y };
}
