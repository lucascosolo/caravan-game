/**
 * Guard for the replay route (chunk 22), typed against replayTypes.ts. Same rules as
 * shapes.ts: lists bounded, numbers bounded where they size a render, extra fields ignored.
 *
 * The `log` is passed through as an opaque object: the client's ONLY reader of it is
 * `readReplay` (@caravan/resolver/replay), which validates far more than a shape can — the
 * seal, every row's arity and ids, the keyframe schedule, and that interpolating the
 * rows reproduces every keyframe. A log it refuses never renders (the player says why).
 */
import { ShapeError, array, boolean, integer, literal, nullable, object, optional, string, type Guard } from "./shape.ts";
import type {
  ReplayCompactedView,
  RecentFightView,
  RecentFightsView,
  ReplayFenceLabelView,
  ReplayOutcomeView,
  ReplaySettledView,
  ReplaySiegeLabelView,
  ReplayTrapLabelView,
  ReplayUnitLabelView,
  ReplayView,
} from "./replayTypes.ts";

const ID = string({ maxLength: 160 });
const REF = string({ maxLength: 128 });
const NAME = string({ maxLength: 128 });
const WORD = string({ maxLength: 64 });
const INDEX = integer({ min: 0, max: 10_000 });
const HP = integer({ min: 0, max: 100_000_000 });
const VERSION = integer({ min: 0, max: 1_000_000 });
const COIN = integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const SIGNED = integer({ min: -1_000_000_000, max: 1_000_000_000 });
const LEVEL = integer({ min: 0, max: 1000 });
/** A fixed-point position on the field (1/1024 cell; the field is 32 × 32 cells). */
const FIXED_POS = integer({ min: 0, max: 1_000_000 });
/** Bounds on what a renderer would build a node for: a full load is 16 v 8 units, 28 segments, 6 traps. */
const UNITS = { maxLength: 256 } as const;
const FENCES = { maxLength: 128 } as const;
const TRAPS = { maxLength: 128 } as const;
const ITEMS = { maxLength: 256 } as const;

/** The stored log: any JSON object, or null. `readReplay` is its real validator. */
const opaqueLog: Guard<unknown> = (v, path) => {
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new ShapeError(path, "object or null", v);
  return v;
};

const outcome: Guard<ReplayOutcomeView> = object({
  kind: literal("caravan_held", "caravan_overrun", "stalemate"),
  depth: integer({ min: 0, max: 1024 }),
  endTick: integer({ min: 0, max: 100_000_000 }),
  loot: COIN,
});

const unitLabel: Guard<ReplayUnitLabelView> = object({
  u: INDEX,
  side: literal("attacker", "defender"),
  ref: REF,
  typeId: ID,
  level: integer({ min: 1, max: 1000 }),
  maxHp: integer({ min: 1, max: 100_000_000 }),
  hp: HP,
  displayName: NAME,
  ability: nullable(NAME),
  stance: nullable(literal("nearest", "traps", "core", "guard", "hold", "reserve")),
});

const fenceLabel: Guard<ReplayFenceLabelView> = object({
  f: INDEX,
  ref: REF,
  segment: INDEX,
  tierId: ID,
  category: WORD,
  maxHp: integer({ min: 1, max: 100_000_000 }),
  hp: HP,
  displayName: NAME,
});

const trapLabel: Guard<ReplayTrapLabelView> = object({ i: INDEX, ref: REF, typeId: ID, x: FIXED_POS, y: FIXED_POS, displayName: NAME, category: nullable(WORD) });

const siegeLabel: Guard<ReplaySiegeLabelView> = object({
  typeId: ID,
  displayName: NAME,
  counters: nullable(object({ kind: literal("fence", "trap"), category: WORD })),
});

const settled: Guard<ReplaySettledView> = object({
  source: literal("ledger"),
  applied: boolean(),
  coin: array(object({ reason: WORD, amount: COIN, discarded: COIN }), ITEMS),
  coinLost: nullable(object({ amount: COIN, transferred: COIN, destroyed: COIN, recipientAuthored: optional(boolean()) })),
  reputation: array(object({ pool: WORD, delta: SIGNED }), ITEMS),
  ladder: array(object({ pool: WORD, pointsDelta: SIGNED, levelBefore: LEVEL, levelAfter: LEVEL }), ITEMS),
  unlockPoints: array(object({ pool: WORD, points: SIGNED }), ITEMS),
  deMerged: array(object({ typeId: ID, displayName: NAME, fromLevel: LEVEL, toLevel: LEVEL }), ITEMS),
  destroyed: array(object({ typeId: ID, displayName: NAME, mergeLevel: LEVEL }), ITEMS),
  trip: nullable(object({ ended: boolean(), endReason: nullable(WORD), unbankedCoin: nullable(COIN) })),
});

const COUNT = integer({ min: 0, max: 10_000 });

/** PHASE-2 §36: the results summary kept when the log was compacted. */
const compacted: Guard<ReplayCompactedView> = object({
  reason: literal("retention", "size_budget"),
  compactedAt: string({ maxLength: 64 }),
  logCreatedAt: string({ maxLength: 64 }),
  tally: nullable(
    object({
      raiders: COUNT,
      raidersFallen: COUNT,
      defenders: COUNT,
      defendersFallen: COUNT,
      fences: COUNT,
      fencesBroken: COUNT,
      traps: COUNT,
      trapsSprung: COUNT,
      trapsNullified: optional(COUNT),
      coreReached: boolean(),
      deepest: nullable(object({ side: literal("attacker", "defender"), typeId: ID, displayName: NAME })),
    }),
  ),
});

export const replayShape: Guard<ReplayView> = object({
  jobId: ID,
  viewer: literal("caravan", "party_owner"),
  tripId: nullable(ID),
  encounterIndex: integer({ min: 1, max: 1_000_000 }),
  resolverVersion: nullable(VERSION),
  currentResolverVersion: VERSION,
  logFormat: nullable(VERSION),
  renderable: boolean(),
  reason: nullable(string({ maxLength: 2000 })),
  outcome: nullable(outcome),
  labels: object({ units: array(unitLabel, UNITS), fences: array(fenceLabel, FENCES), traps: array(trapLabel, TRAPS), siege: array(siegeLabel, { maxLength: 16 }) }),
  settled,
  log: opaqueLog,
  compacted: optional(nullable(compacted)),
  opponent: optional(nullable(object({ authored: boolean() }))),
});

const recentFight: Guard<RecentFightView> = object({
  jobId: ID,
  tripId: ID,
  encounterIndex: integer({ min: 1, max: 1_000_000 }),
  outcome: literal("caravan_held", "caravan_overrun", "stalemate"),
  depth: integer({ min: 0, max: 1024 }),
  settledAt: string({ maxLength: 64 }),
  replay: literal("log", "no_log", "compacted", "pruned"),
});

export const recentFightsShape: Guard<RecentFightsView> = object({
  encounters: array(recentFight, { maxLength: 1000 }),
  retention: object({ days: integer({ min: 1, max: 100_000 }), minPerCaravan: integer({ min: 1, max: 100_000 }) }),
});
