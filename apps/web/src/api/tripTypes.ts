/**
 * Response types of the trip loop's routes (chunk 15 server, chunk 23 client), hand-written:
 * only the fields the trip client renders. Guards in tripShapes.ts are typed against these.
 *
 *   GET  /me/caravans/:id/trip                       TripStatusView
 *   POST /me/caravans/:id/trip/start                 TripStartResult      (409 trip_cap_exhausted → TripCapRefusal body)
 *   POST /me/caravans/:id/trip/encounters/:n/commit  EncounterCommitResult
 *   GET  /me/caravans/:id/trip/preview               StakesPreview        (the bank-or-push stakes, itemized)
 *   POST /me/caravans/:id/trip/push                  PushResult
 *   POST /me/caravans/:id/trip/bank                  BankResult
 */

/** The account's trip cap: one use per trip, time-gated only (never purchasable). */
export interface TripCapView {
  readonly available: number;
  readonly cap: number;
  readonly regenMs: number;
  /** Server epoch ms when the next use returns; null when full. */
  readonly nextRegenAtMs: number | null;
  readonly fullAtMs: number | null;
  readonly gate: "time";
}

export type TripPhase = "arranging" | "resolving" | "resolution_unavailable" | "decide" | "ended";
export type EncounterOutcomeKind = "caravan_held" | "caravan_overrun" | "stalemate";

export interface UnitRefView {
  readonly ref: string;
  readonly typeId: string;
  readonly mergeLevel: number;
}
/**
 * A unit that died on the trip and is de-merged for it (the server's `DeMergedUnit`,
 * apps/server/src/trip/stakes.ts): one level, floored, so `toLevel === fromLevel` at level 1.
 */
export interface DeMergedUnitView {
  readonly ref: string;
  readonly typeId: string;
  readonly fromLevel: number;
  readonly toLevel: number;
  readonly diedAtEncounter: number;
}
export interface TrapRefView {
  readonly ref: string;
  readonly typeId: string;
}

/** What one encounter's fight cost, as the server projected it from the resolution. */
export interface EncounterResultView {
  readonly jobId: string;
  readonly unitsKilled: readonly (UnitRefView & { readonly hpBefore: number; readonly maxHp: number })[];
  readonly unitsDamaged: readonly (UnitRefView & { readonly hpBefore: number; readonly hpAfter: number; readonly maxHp: number })[];
  readonly unitsUnhurt: readonly (UnitRefView & { readonly hp: number; readonly maxHp: number })[];
  readonly trapsSpent: readonly TrapRefView[];
  readonly trapsUnfired: readonly TrapRefView[];
  readonly fencesBroken: readonly { readonly ref: string; readonly tierId: string; readonly maxHp: number }[];
  readonly fencesDamaged: readonly { readonly ref: string; readonly tierId: string; readonly hpBefore: number; readonly hpAfter: number; readonly maxHp: number }[];
}

export interface TripEncounterView {
  readonly index: number;
  readonly outcome: EncounterOutcomeKind;
  /** Fixed-point 0..1024: how far the attackers got toward the core (1024 = reached it). */
  readonly depth: number;
  readonly deaths: readonly string[];
  /** This encounter's Coin, unbanked until a bank (0 on an overrun). */
  readonly coinAccrued: number;
  readonly decision: "pushed" | "banked" | null;
  readonly result: EncounterResultView | null;
}

/** The refit on a bank (RESTORE_ON_TRIP_END). */
export interface RestoredView {
  readonly unitsHealed: readonly (UnitRefView & { readonly hpAtBank: number; readonly maxHp: number })[];
  readonly trapsRestocked: number;
  readonly fenceSegmentsRebuilt: number;
  /** Units that died on the trip, each de-merged one level (floored) by the bank itself (chunk 19). */
  readonly deMerged: readonly DeMergedUnitView[];
}

export interface BankedEndingView {
  readonly kind: "banked";
  readonly encountersSurvived: number;
  readonly unbankedCoin: number;
  readonly deliveryBonus: number;
  readonly requested: number;
  readonly credited: number;
  readonly discarded: number;
  readonly restored: RestoredView;
}

export interface OverrunEndingView {
  readonly kind: "overrun";
  readonly encounterIndex: number;
  readonly coinLost: number;
  readonly unitsLostOutright: readonly UnitRefView[];
  readonly unitsDeMerged: readonly (UnitRefView & { readonly mergeLevelAfter: number; readonly diedAtEncounter: number })[];
  readonly lossesApplied: boolean;
}

/**
 * Chunk 15 QA D3: a trip whose encounter could not be resolved (its resolution job parked).
 * It ended exactly as a bank after its last survived encounter (`encountersSurvived`; 0 = nothing
 * survived, nothing credited), including the de-merges for deaths in those encounters; nothing
 * of the voided fight was applied; the trip-cap use is not refunded.
 */
export interface VoidedEndingView {
  readonly kind: "voided";
  /** The encounter whose fight could not be resolved: discarded. */
  readonly voidedEncounter: number;
  /** The server's reason (the parked job's last error); technical text, shown as a detail only. */
  readonly reason: string;
  readonly encountersSurvived: number;
  readonly unbankedCoin: number;
  readonly deliveryBonus: number;
  readonly requested: number;
  readonly credited: number;
  readonly discarded: number;
  readonly restored: RestoredView;
}

export type TripEndingView = BankedEndingView | OverrunEndingView | VoidedEndingView;

export interface TripView {
  readonly id: string;
  readonly manifestId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endReason: "banked" | "overrun" | "voided" | null;
  readonly phase: TripPhase;
  readonly encountersResolved: number;
  /** The encounter being arranged / resolved; else null. */
  readonly currentEncounter: number | null;
  readonly job: { readonly id: string; readonly status: string; readonly lastError: string | null } | null;
  /** The survived encounter whose bank-or-push decision is open; else null. */
  readonly decisionFor: number | null;
  readonly unbankedCoin: number;
  readonly encounters: readonly TripEncounterView[];
  readonly ending: TripEndingView | null;
}

export interface TripStatusView {
  readonly caravan: { readonly id: string; readonly state: "in_town" | "on_trip" };
  readonly cap: TripCapView;
  /** The open trip, else the most recent one, else null. */
  readonly trip: TripView | null;
  /** The server's clock at this read: the cap countdown is `nextRegenAtMs − nowMs`, never the device clock. */
  readonly nowMs: number;
}

export interface TripStartResult {
  readonly tripId: string;
  readonly manifestId: string;
  readonly cap: TripCapView;
  readonly status: TripStatusView;
}

/** The 409 `trip_cap_exhausted` body (read from `ApiError.body` through tripCapRefusalShape). */
export interface TripCapRefusal {
  readonly cap: TripCapView;
  readonly retryAfterSeconds: number;
}

export interface EncounterCommitResult {
  readonly jobId: string;
  readonly jobStatus: string;
  readonly created: boolean;
}

export interface StakesUnitView extends UnitRefView {
  readonly hp: number;
  readonly maxHp: number;
  readonly damage: number;
  readonly alive: boolean;
  readonly diedAtEncounter: number | null;
  /** The merge level this unit drops to when it dies (one level, floored). */
  readonly mergeLevelOnDeath: number;
}

export interface StakesPreview {
  readonly tripId: string;
  readonly encountersSurvived: number;
  readonly decisionOpen: boolean;
  readonly decisionFor: number | null;
  readonly unbankedCoin: { readonly total: number; readonly byEncounter: readonly { readonly index: number; readonly coin: number }[] };
  /**
   * What banking now would deliver. OMITTED before the first survived encounter (chunk 15 QA
   * N2): there is nothing to bank yet, and a bank is only offered after surviving one.
   */
  readonly bankNow?: {
    readonly encounterCoin: number;
    readonly deliveryBonus: number;
    readonly total: number;
    readonly forecast: { readonly balance: number; readonly cap: number; readonly room: number; readonly prospectiveEarn: number; readonly wouldCredit: number; readonly wouldDiscard: number; readonly atCap: boolean };
    /** Banking de-merges every unit that died on this trip, exactly as listed (the same plan the bank applies). */
    readonly unitsDeMerged: readonly DeMergedUnitView[];
  } | undefined;
  readonly units: readonly StakesUnitView[];
  readonly ifOverrun: {
    readonly coinLost: number;
    readonly unitsLostOutright: readonly (UnitRefView & { readonly hp: number })[];
    readonly unitsDeMergedNotDestroyed: readonly DeMergedUnitView[];
    /** A unit alive now that dies in the fight the caravan falls in: "de_merged_not_destroyed". */
    readonly unitDyingInTheFinalFight: string;
    /** Where the lost Coin goes: "overrunning_party_owner_capped" (destroyed for an authored party). */
    readonly coinGoesTo: string;
  };
  readonly traps: { readonly remaining: readonly TrapRefView[]; readonly spent: readonly TrapRefView[] };
  readonly fences: {
    readonly intact: readonly { readonly ref: string; readonly tierId: string; readonly hp: number; readonly maxHp: number }[];
    readonly destroyed: readonly { readonly ref: string; readonly tierId: string; readonly maxHp: number }[];
  };
  readonly nextEncounter: {
    readonly index: number;
    readonly reward: number;
    readonly bankTotalIfSurvived: number;
    readonly difficulty: { readonly escalationApplied: number; readonly risePerEncounter: number; /** Omitted before the first survived encounter (chunk 15 QA N2): there is no "this encounter" yet. */ readonly harderThanThisEncounter?: boolean | undefined };
    readonly partyArrivesFresh: boolean;
  };
  readonly lastOpponent: {
    readonly encounterIndex: number;
    readonly reputation: { readonly rating?: number | undefined; readonly gapFromCaravan?: number | undefined; readonly gapBeyondBand?: number | undefined; readonly sandbagEarnMultiplier?: number | undefined };
  } | null;
}

export interface PushResult {
  readonly tripId: string;
  readonly pushedPast: number;
  readonly nextEncounter: number;
  readonly replayed: boolean;
}

export interface BankResult {
  readonly tripId: string;
  readonly encountersSurvived: number;
  readonly requested: number;
  readonly credited: number;
  readonly discarded: number;
  /** The town balance right after the credit. A replayed bank returns the stored one (chunk 15 QA N5); null for a bank recorded before N5. */
  readonly balanceAfter: number | null;
  readonly restored: RestoredView;
  readonly replayed: boolean;
}
