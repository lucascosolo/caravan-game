/**
 * Guard for the replay route (chunk 22), typed against replayTypes.ts. Same rules as
 * shapes.ts: lists bounded, numbers bounded where they size a render, extra fields ignored.
 *
 * The `log` is passed through as an opaque object: the client's ONLY reader of it is
 * `readReplay` (@caravan/resolver/replay), which validates far more than a shape can — the
 * checksum, every row's arity and ids, the keyframe schedule, and that interpolating the
 * rows reproduces every keyframe. A log it refuses never renders (the player says why).
 */
import { ShapeError, array, boolean, integer, literal, nullable, object, string, type Guard } from "./shape.ts";
import type { ReplayFenceLabelView, ReplayOutcomeView, ReplayTrapLabelView, ReplayUnitLabelView, ReplayView } from "./replayTypes.ts";

const ID = string({ maxLength: 160 });
const REF = string({ maxLength: 128 });
const NAME = string({ maxLength: 128 });
const INDEX = integer({ min: 0, max: 10_000 });
const HP = integer({ min: 0, max: 100_000_000 });
const VERSION = integer({ min: 0, max: 1_000_000 });
/** A fixed-point position on the field (1/1024 cell; the field is 32 × 32 cells). */
const FIXED_POS = integer({ min: 0, max: 1_000_000 });
/** Bounds on what a renderer would build a node for: a full load is 16 v 8 units, 28 segments, 6 traps. */
const UNITS = { maxLength: 256 } as const;
const FENCES = { maxLength: 128 } as const;
const TRAPS = { maxLength: 128 } as const;

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
  loot: integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
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
});

const fenceLabel: Guard<ReplayFenceLabelView> = object({
  f: INDEX,
  ref: REF,
  segment: INDEX,
  tierId: ID,
  maxHp: integer({ min: 1, max: 100_000_000 }),
  hp: HP,
  displayName: NAME,
});

const trapLabel: Guard<ReplayTrapLabelView> = object({ i: INDEX, ref: REF, typeId: ID, x: FIXED_POS, y: FIXED_POS, displayName: NAME });

export const replayShape: Guard<ReplayView> = object({
  jobId: ID,
  viewer: literal("caravan", "party_owner"),
  tripId: ID,
  encounterIndex: integer({ min: 1, max: 1_000_000 }),
  resolverVersion: nullable(VERSION),
  currentResolverVersion: VERSION,
  logFormat: nullable(VERSION),
  renderable: boolean(),
  reason: nullable(string({ maxLength: 2000 })),
  outcome: nullable(outcome),
  labels: object({ units: array(unitLabel, UNITS), fences: array(fenceLabel, FENCES), traps: array(trapLabel, TRAPS) }),
  log: opaqueLog,
});
