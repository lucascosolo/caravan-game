/**
 * Fixtures for the town, outfit and party component tests (chunk 17), shaped like the
 * server's chunk 09 / 16 / 18 responses (and run through the same payload guards in
 * shapes.test so they cannot drift from what the client accepts).
 */
import { PARTY_CONFIG_VERSION, siegeCounterEntry } from "@caravan/circle";
import { SIEGE_TYPES } from "@caravan/content";
import type { Api } from "../api/client.ts";
import type { EconomyView, MeResponse, MergePreview, PartyView, RecruitView, RefugeeView, UnitStatsView, UnlocksResponse } from "../api/types.ts";
import { ACCOUNT_ID, CARAVAN_ID } from "./fixtures.ts";

export { ACCOUNT_ID, CARAVAN_ID };

export function fakeApi(over: Partial<Api> = {}): Api {
  const notCalled = (): Promise<never> => Promise.reject(new Error("not expected"));
  return {
    register: notCalled,
    login: notCalled,
    logout: notCalled,
    me: notCalled,
    unlocks: notCalled,
    progression: notCalled,
    spendUnlock: notCalled,
    packManifest: notCalled,
    manifest: notCalled,
    saveFormation: notCalled,
    formation: notCalled,
    commitFormation: notCalled,
    searchCandidates: notCalled,
    candidates: notCalled,
    chooseCandidate: notCalled,
    tripStatus: notCalled,
    startTrip: notCalled,
    commitEncounter: notCalled,
    tripPreview: notCalled,
    pushTrip: notCalled,
    bankTrip: notCalled,
    economy: notCalled,
    previewMerge: notCalled,
    commitMerge: notCalled,
    refugees: notCalled,
    claimRefugee: notCalled,
    refreshRefugees: notCalled,
    rerollRefugees: notCalled,
    recruitList: notCalled,
    recruit: notCalled,
    party: notCalled,
    saveParty: notCalled,
    partyFeed: notCalled,
    store: notCalled,
    purchasePack: notCalled,
    storePurchases: notCalled,
    cosmetics: notCalled,
    equipCosmetic: notCalled,
    unequipCosmetic: notCalled,
    replay: notCalled,
    ...over,
  };
}

export const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface FixtureUnit {
  readonly id: string;
  readonly typeId: string;
  readonly level: number;
}

export function meWith(units: readonly FixtureUnit[], state: "in_town" | "on_trip" = "in_town"): MeResponse {
  return {
    account: { id: ACCOUNT_ID, username: "dev" },
    caravans: [
      {
        id: CARAVAN_ID,
        name: "Dev Caravan",
        region_id: "desert",
        state,
        units: units.map((u) => ({ id: u.id, caravan_id: CARAVAN_ID, unit_type_id: u.typeId, merge_level: u.level })),
      },
    ],
  };
}

export function economyView(over: Partial<EconomyView> = {}): EconomyView {
  return {
    balance: 1200,
    cap: 50_000,
    room: 48_800,
    atCap: false,
    trickle: { ratePerHour: 200, msPerCoin: 18_000, pending: 40, ledgerBalance: 1160, nextCoinInMs: 9_000, accruedThroughMs: Date.UTC(2026, 9, 11, 12, 0, 0) },
    overflow: { prospectiveEarn: 0, wouldCredit: 0, wouldDiscard: 0, warn: false, message: "Your store has room for 48800 more Coin right now." },
    earn: { encounterSchedule: [100, 150, 225], bankedTripBonus: 250, partyWin: 50 },
    merge: { costPerResultingUnitByLevel: { "2": 250, "3": 900, "4": 3000, "5": 9500 }, recipes: [{ spend: 2, produce: 1 }, { spend: 5, produce: 3 }], levelCap: 5, slotCost: 1 },
    ...over,
  };
}

const stats = (hp: number, mult: number): UnitStatsView => ({ hp, offense: 60, defense: 40, damageOutputMult: mult, multDen: 1024, referenceHit: Math.floor((60 * mult) / 1024) });

export function mergePreview(ids: readonly string[], over: Partial<MergePreview> = {}): MergePreview {
  return {
    caravanId: CARAVAN_ID,
    unitTypeId: "desert.dust_rider",
    unitDisplayName: "Dust Rider",
    recipe: { spend: 2, produce: 1 },
    fromLevel: 1,
    toLevel: 2,
    costPerUnit: 250,
    totalCost: 250,
    balance: 1200,
    pendingTrickle: 40,
    affordable: true,
    consumed: { instanceIds: [...ids], inParty: [], count: 2, slots: 2, perUnit: stats(400, 1024), combined: stats(800, 2048) },
    requiresConfirmInParty: false,
    produced: { count: 1, slots: 1, perUnit: stats(720, 1843), combined: stats(720, 1843) },
    slotsFreed: 1,
    ability: { archetype: "dash_strike", displayName: "Dash Strike" },
    ...over,
  };
}

const summary = (id: string, name: string) => ({ unitTypeId: id, displayName: name, affinity: "grit", ability: { archetype: "dash_strike", displayName: "Dash Strike" } });

export function refugeeView(over: { menu?: Partial<RefugeeView["menu"]>; timer?: Partial<RefugeeView["timer"]>; reroll?: Partial<RefugeeView["reroll"]> } & Partial<Omit<RefugeeView, "menu" | "timer" | "reroll">> = {}): RefugeeView {
  const { menu, timer, reroll, ...rest } = over;
  return {
    caravanId: CARAVAN_ID,
    menu: {
      sequence: 7,
      origin: "free",
      rerollsThisWindow: 0,
      offers: [
        { ...summary("desert.dust_rider", "Dust Rider"), slot: 0 },
        { ...summary("desert.well_digger", "Well Digger"), slot: 1 },
        { ...summary("desert.dust_rider", "Dust Rider"), slot: 2 },
      ],
      generatedAtMs: 1_000,
      claimed: null,
      ...menu,
    },
    timer: { intervalMs: 5_400_000, windowOpenedAtMs: 1_000, nextFreeRefreshAtMs: 5_401_000, msUntilFreeRefresh: 65_000, freeRefreshDue: false, refreshedNow: false, ...timer },
    reroll: { nextCost: 150, nextIndex: 0, schedule: [150, 300, 600], affordable: true, forfeitsUnclaimedOffer: true, blockedByFreeRefresh: false, ...reroll },
    balance: 1200,
    pendingTrickle: 40,
    inventory: { count: 3, cap: 200, room: 197, full: false },
    ...rest,
  };
}

export function recruitView(over: Partial<RecruitView> = {}): RecruitView {
  return {
    caravanId: CARAVAN_ID,
    costBase: 600,
    scaling: "none",
    recruitable: [
      { ...summary("desert.dust_rider", "Dust Rider"), cost: 600, affordable: true },
      { ...summary("desert.well_digger", "Well Digger"), cost: 600, affordable: true },
    ],
    locked: [summary("desert.vaquero", "Vaquero"), summary("desert.longhorn_bull", "Longhorn Bull")],
    balance: 1200,
    pendingTrickle: 40,
    inventory: { count: 3, cap: 200, room: 197, full: false },
    availability: { cooldown: null, dailyLimit: null },
    ...over,
  };
}

export function partyView(over: Partial<PartyView> = {}): PartyView {
  return {
    id: uid(900),
    slot: 0,
    savedAt: "2026-10-11T12:00:00.000Z",
    hash: "abc",
    config: { v: PARTY_CONFIG_VERSION, units: [], siege: [] },
    valid: false,
    issues: [{ code: "party_empty", message: "a standing party needs at least one unit" }],
    scout: null,
    edges: [],
    caps: { units: 8, siege: 2, edges: 4, editCooldownMs: 0, partiesPerAccount: 1 },
    rules: { template: true, neverConsumed: true, unitsMayAlsoBePackedOnTrips: true, ratingInUse: "offense", stances: ["nearest", "traps", "core"] },
    roster: [
      { instanceId: uid(1), caravanId: CARAVAN_ID, typeId: "desert.dust_rider", displayName: "Dust Rider", mergeLevel: 2, slotCost: 1, offense: 60, defense: 40, hp: 720, unlocked: true, inParty: false, packedOnTrip: false, aliveOnTrip: null },
      { instanceId: uid(2), caravanId: CARAVAN_ID, typeId: "desert.well_digger", displayName: "Well Digger", mergeLevel: 1, slotCost: 1, offense: 30, defense: 70, hp: 500, unlocked: true, inParty: false, packedOnTrip: true, aliveOnTrip: true },
    ],
    siegeCatalog: SIEGE_TYPES.map((s, i) => ({ ...siegeCounterEntry(s), unlocked: i === 0 })),
    ...over,
  };
}

export function unlocksWith(trapReached: readonly string[]): UnlocksResponse {
  return {
    webs: [
      {
        id: uid(800),
        pool: "trap",
        scope: "account",
        regionId: null,
        accountId: ACCOUNT_ID,
        caravanId: null,
        points: { granted: 0, spent: 0, available: 0 },
        nodes: trapReached.map((id) => ({ id, tier: 0, cost: 0, requires: [], starting: true, reached: true, prerequisitesMet: true, affordable: false, missing: [] })),
      },
    ],
  };
}
