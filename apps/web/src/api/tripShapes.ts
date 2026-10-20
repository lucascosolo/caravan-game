/**
 * Guards for the trip loop's routes (chunk 23), typed against tripTypes.ts. Same rules as
 * shapes.ts: every number that sizes a render is bounded, every list has a maxLength, and
 * extra fields are ignored — the server may grow these bodies (chunk 19 wires losses into the
 * same responses), and an additive field must never become `bad_payload`.
 */
import { ShapeError, array, boolean, integer, literal, nullable, object, optional, string, type Guard } from "./shape.ts";
import type {
  BankResult,
  BankedEndingView,
  EncounterCommitResult,
  EncounterResultView,
  OverrunEndingView,
  PushResult,
  RestoredView,
  StakesPreview,
  TripCapRefusal,
  TripCapView,
  TripEncounterView,
  TripEndingView,
  TripStartResult,
  TripStatusView,
  TripView,
  VoidedEndingView,
} from "./tripTypes.ts";

const ID = string({ maxLength: 160 });
const REF = string({ maxLength: 128 });
const TS = string({ maxLength: 64 });
const MS = integer({ min: 0 });
const COIN = integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const SIGNED = integer({ min: -1_000_000_000, max: 1_000_000_000 });
const COUNT = integer({ min: 0, max: 100_000 });
const LEVEL = integer({ min: 1, max: 5 });
const HP = integer({ min: 0, max: 100_000_000 });
const ENCOUNTER = integer({ min: 0, max: 1_000_000 });
const LIST = { maxLength: 512 } as const;
const MAX_ENCOUNTERS_SHOWN = 1_000;

/** Null when absent or null (a field an older server did not send), else the inner guard. */
const orNull = <T,>(inner: Guard<T>): Guard<T | null> => (v, path) => (v === undefined || v === null ? null : inner(v, path));
/** An empty list when absent (an additive field), else the inner list guard. */
const orEmpty = <T,>(inner: Guard<readonly T[]>): Guard<readonly T[]> => (v, path) => (v === undefined ? [] : inner(v, path));

export const tripCapShape: Guard<TripCapView> = object({
  available: COUNT,
  cap: COUNT,
  regenMs: integer({ min: 1 }),
  nextRegenAtMs: nullable(MS),
  fullAtMs: nullable(MS),
  gate: literal("time"),
});

const unitRef = { ref: REF, typeId: ID, mergeLevel: LEVEL } as const;
const trapRef = object({ ref: REF, typeId: ID });
/** The server's `DeMergedUnit` (trip/stakes.ts), the same in the preview, the bank and the banked ending. */
const deMergedUnit = object({ ref: REF, typeId: ID, fromLevel: LEVEL, toLevel: LEVEL, diedAtEncounter: ENCOUNTER });

const encounterResult: Guard<EncounterResultView> = object({
  jobId: ID,
  unitsKilled: array(object({ ...unitRef, hpBefore: HP, maxHp: HP }), LIST),
  unitsDamaged: array(object({ ...unitRef, hpBefore: HP, hpAfter: HP, maxHp: HP }), LIST),
  unitsUnhurt: orEmpty(array(object({ ...unitRef, hp: HP, maxHp: HP }), LIST)),
  trapsSpent: array(trapRef, LIST),
  trapsUnfired: orEmpty(array(trapRef, LIST)),
  fencesBroken: array(object({ ref: REF, tierId: ID, maxHp: HP }), LIST),
  fencesDamaged: array(object({ ref: REF, tierId: ID, hpBefore: HP, hpAfter: HP, maxHp: HP }), LIST),
});

const outcomeKind = literal("caravan_held", "caravan_overrun", "stalemate");

const tripEncounter: Guard<TripEncounterView> = object({
  index: integer({ min: 1, max: 1_000_000 }),
  outcome: outcomeKind,
  depth: integer({ min: 0, max: 1024 }),
  deaths: array(REF, LIST),
  coinAccrued: COIN,
  decision: nullable(literal("pushed", "banked")),
  result: orNull(encounterResult),
});

const restoredFields = {
  unitsHealed: orEmpty(array(object({ ...unitRef, hpAtBank: HP, maxHp: HP }), LIST)),
  trapsRestocked: COUNT,
  fenceSegmentsRebuilt: COUNT,
} as const;
/**
 * The refit a bank answers with (POST …/trip/bank). `deMerged` is REQUIRED here (chunk 23 QA
 * S2): an `orEmpty` once turned the server's rename of this list into a silent `[]`, so a
 * player's de-merge was never shown. A missing list is `bad_payload`, never "nobody died".
 */
export const restoredShape: Guard<RestoredView> = object({ ...restoredFields, deMerged: array(deMergedUnit, LIST) });
/**
 * The same refit as the `trip_banked` event stored it (trip.ending.restored). A trip banked
 * before chunk 19 recorded no de-merges (none were applied then), so an absent list is `[]`.
 */
const endingRestoredShape: Guard<RestoredView> = object({ ...restoredFields, deMerged: orEmpty(array(deMergedUnit, LIST)) });

const bankedEnding: Guard<BankedEndingView> = object({
  kind: literal("banked"),
  encountersSurvived: ENCOUNTER,
  unbankedCoin: COIN,
  deliveryBonus: COIN,
  requested: COIN,
  credited: COIN,
  discarded: COIN,
  restored: endingRestoredShape,
});

const overrunEnding: Guard<OverrunEndingView> = object({
  kind: literal("overrun"),
  encounterIndex: ENCOUNTER,
  coinLost: COIN,
  unitsLostOutright: array(object(unitRef), LIST),
  unitsDeMerged: array(object({ ...unitRef, mergeLevelAfter: LEVEL, diedAtEncounter: ENCOUNTER }), LIST),
  lossesApplied: boolean(),
});

/**
 * Chunk 15 QA D3: the void path's ending, as the `trip_voided` event recorded it. Every voided
 * trip post-dates chunk 19, so its refit's `deMerged` is REQUIRED (as on a bank answer): a
 * missing list is `bad_payload`, never "nobody died".
 */
const voidedEnding: Guard<VoidedEndingView> = object({
  kind: literal("voided"),
  voidedEncounter: integer({ min: 1, max: 1_000_000 }),
  reason: string({ maxLength: 4096 }),
  encountersSurvived: ENCOUNTER,
  unbankedCoin: COIN,
  deliveryBonus: COIN,
  requested: COIN,
  credited: COIN,
  discarded: COIN,
  restored: restoredShape,
});

const tripEnding: Guard<TripEndingView> = (v, path) => {
  const kind = v && typeof v === "object" ? (v as { kind?: unknown }).kind : undefined;
  if (kind === "banked") return bankedEnding(v, path);
  if (kind === "overrun") return overrunEnding(v, path);
  if (kind === "voided") return voidedEnding(v, path);
  throw new ShapeError(`${path}.kind`, `one of "banked" | "overrun" | "voided"`, kind);
};

const tripView: Guard<TripView> = object({
  id: ID,
  manifestId: ID,
  startedAt: TS,
  endedAt: nullable(TS),
  endReason: nullable(literal("banked", "overrun", "voided")),
  phase: literal("arranging", "resolving", "resolution_unavailable", "decide", "ended"),
  encountersResolved: ENCOUNTER,
  currentEncounter: nullable(integer({ min: 1, max: 1_000_000 })),
  job: nullable(object({ id: ID, status: string({ maxLength: 32 }), lastError: nullable(string({ maxLength: 4096 })) })),
  decisionFor: nullable(integer({ min: 1, max: 1_000_000 })),
  unbankedCoin: COIN,
  encounters: array(tripEncounter, { maxLength: MAX_ENCOUNTERS_SHOWN }),
  ending: orNull(tripEnding),
});

export const tripStatusShape: Guard<TripStatusView> = object({
  caravan: object({ id: ID, state: literal("in_town", "on_trip") }),
  cap: tripCapShape,
  trip: nullable(tripView),
  nowMs: MS,
});

/** Final guardrail review r4 S1: POST …/trip/return ("Return to town"). */
export const returnToTownShape: Guard<{ readonly returned: boolean; readonly status: TripStatusView }> = object({ returned: boolean(), status: tripStatusShape });
export const tripStartShape: Guard<TripStartResult> = object({ tripId: ID, manifestId: ID, cap: tripCapShape, status: tripStatusShape });

export const tripCapRefusalShape: Guard<TripCapRefusal> = object({ cap: tripCapShape, retryAfterSeconds: integer({ min: 0, max: 86_400 }) });

export const encounterCommitShape: Guard<EncounterCommitResult> = object({ jobId: ID, jobStatus: string({ maxLength: 32 }), created: boolean() });

const fenceIntact = object({ ref: REF, tierId: ID, hp: HP, maxHp: HP });
const fenceDestroyed = object({ ref: REF, tierId: ID, maxHp: HP });

const stakesPreviewFields: Guard<StakesPreview> = object({
  tripId: ID,
  encountersSurvived: ENCOUNTER,
  decisionOpen: boolean(),
  decisionFor: nullable(integer({ min: 1, max: 1_000_000 })),
  unbankedCoin: object({ total: COIN, byEncounter: array(object({ index: integer({ min: 1, max: 1_000_000 }), coin: COIN }), { maxLength: MAX_ENCOUNTERS_SHOWN }) }),
  // Chunk 15 QA N2: omitted before the first survived encounter (nothing to bank yet).
  bankNow: optional(object({
    encounterCoin: COIN,
    deliveryBonus: COIN,
    total: COIN,
    forecast: object({ balance: COIN, cap: COIN, room: COIN, prospectiveEarn: COIN, wouldCredit: COIN, wouldDiscard: COIN, atCap: boolean() }),
    unitsDeMerged: array(deMergedUnit, LIST),
  })),
  units: array(
    object({ ...unitRef, hp: HP, maxHp: HP, damage: HP, alive: boolean(), diedAtEncounter: nullable(ENCOUNTER), mergeLevelOnDeath: LEVEL }),
    LIST,
  ),
  ifOverrun: object({
    coinLost: COIN,
    unitsLostOutright: array(object({ ...unitRef, hp: HP }), LIST),
    unitsDeMergedNotDestroyed: array(deMergedUnit, LIST),
    unitDyingInTheFinalFight: string({ maxLength: 64 }),
    coinGoesTo: string({ maxLength: 64 }),
  }),
  traps: object({ remaining: array(trapRef, LIST), spent: array(trapRef, LIST) }),
  fences: object({ intact: array(fenceIntact, LIST), destroyed: array(fenceDestroyed, LIST) }),
  nextEncounter: object({
    index: integer({ min: 1, max: 1_000_000 }),
    reward: COIN,
    bankTotalIfSurvived: COIN,
    difficulty: object({ escalationApplied: SIGNED, risePerEncounter: SIGNED, harderThanThisEncounter: optional(boolean()) }),
    partyArrivesFresh: boolean(),
  }),
  lastOpponent: nullable(
    object({
      encounterIndex: ENCOUNTER,
      reputation: object({ rating: optional(SIGNED), gapFromCaravan: optional(SIGNED), gapBeyondBand: optional(SIGNED), sandbagEarnMultiplier: optional(integer({ min: 0, max: 1_000_000 })) }),
    }),
  ),
});

/**
 * Chunk 15 QA N2: `bankNow` and `nextEncounter.difficulty.harderThanThisEncounter` are omitted
 * ONLY before the first survived encounter. Once one is survived both must be there: an absent
 * bank quote after surviving is `bad_payload`, never a silent "nothing to bank" (the chunk 23
 * QA S2 lesson: an optional field must not swallow a server drift).
 */
export const stakesPreviewShape: Guard<StakesPreview> = (v, path) => {
  const p = stakesPreviewFields(v, path);
  if (p.encountersSurvived >= 1) {
    if (p.bankNow === undefined) throw new ShapeError(`${path}.bankNow`, "present once an encounter is survived", undefined);
    if (p.nextEncounter.difficulty.harderThanThisEncounter === undefined) {
      throw new ShapeError(`${path}.nextEncounter.difficulty.harderThanThisEncounter`, "present once an encounter is survived", undefined);
    }
  }
  return p;
};

export const pushResultShape: Guard<PushResult> = object({ tripId: ID, pushedPast: ENCOUNTER, nextEncounter: ENCOUNTER, replayed: boolean() });

export const bankResultShape: Guard<BankResult> = object({
  tripId: ID,
  encountersSurvived: ENCOUNTER,
  requested: COIN,
  credited: COIN,
  discarded: COIN,
  balanceAfter: nullable(COIN),
  restored: restoredShape,
  replayed: boolean(),
});
