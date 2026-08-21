import { LIVING_UNIT_TYPES, SIEGE_TYPES, TRAP_TYPES, type UnlockedAccess } from "@caravan/content";
import { CountingIdGenerator } from "../domain/ids.js";
import type { UnitInstance, Account } from "../domain/account.js";
import {
  InMemoryStandingPartyRepository,
  InMemoryUnitInstanceRepository,
  InMemoryReplayRepository,
  InMemoryResolutionRecordRepository,
  InMemoryAccessRepository,
  InMemoryAccountRepository,
  InMemoryLedgerRepository,
} from "../repo/inMemory.js";
import { StandingPartyService } from "../services/standingPartyService.js";
import { CoinService } from "../services/coinService.js";
import { MergeService } from "../services/mergeService.js";
import { PackingService } from "../services/packingService.js";

export const ACCOUNT_ID = "acc_1";
export const CARAVAN_ID = "car_1";
export const DEFAULT_NOW = "2026-01-01T00:00:00.000Z";

export function fullAccess(): UnlockedAccess {
  return {
    livingUnitTypeIds: new Set(LIVING_UNIT_TYPES.map((t) => t.id)),
    siegeTypeIds: new Set(SIEGE_TYPES.map((t) => t.id)),
    trapTypeIds: new Set(TRAP_TYPES.map((t) => t.id)),
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

/** Harness for economy/merge tests: account with Coin, seeded unit instances. */
export function buildEconomyHarness(opts: {
  unitCount?: number;
  initialCoin?: number;
  access?: UnlockedAccess;
  trickleCursor?: string;
} = {}) {
  const unitCount = opts.unitCount ?? 8;
  const initialCoin = opts.initialCoin ?? 10_000;
  const access = opts.access ?? fullAccess();
  const trickleCursor = opts.trickleCursor ?? DEFAULT_NOW;

  const accountRepo = new InMemoryAccountRepository();
  const unitRepo = new InMemoryUnitInstanceRepository();
  const ledgerRepo = new InMemoryLedgerRepository();
  const accessRepo = new InMemoryAccessRepository();
  accessRepo.grant(ACCOUNT_ID, access);
  const idGen = new CountingIdGenerator();

  const account: Account = {
    id: ACCOUNT_ID,
    coinBalance: initialCoin,
    coinLastTrickleAt: trickleCursor,
  };
  accountRepo.save(account);

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

  const coinService = new CoinService(accountRepo, ledgerRepo, idGen);
  const mergeService = new MergeService(unitRepo, coinService, idGen);
  const packingService = new PackingService(unitRepo, accessRepo, idGen);
  packingService.initCaravan(CARAVAN_ID);

  return {
    accountRepo,
    unitRepo,
    ledgerRepo,
    accessRepo,
    idGen,
    account,
    unitInstances,
    coinService,
    mergeService,
    packingService,
  };
}

export function cell(x: number, y: number) {
  return { x, y };
}