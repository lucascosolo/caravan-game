/**
 * Guards for the inbox routes (chunk 29), typed against inboxTypes.ts. Same rules as shapes.ts:
 * lists bounded, numbers bounded where they size a render, extra fields ignored. An item of a
 * category this client does not know is refused (bad_payload), never drawn half-understood.
 *
 * A strike line is checked to carry no account id and no caravan id of the struck player
 * (PHASE-2 §29): no `caravanId` on the defender and no key ending in `accountId` anywhere in the
 * line (chunk 29 QA N8). `object()` ignores extra fields, so without this a server regression
 * that re-added one would pass silently.
 */
import { ShapeError, array, boolean, integer, literal, nullable, object, string, type Guard } from "./shape.ts";
import type { InboxItemView, InboxMarkResult, InboxStrikeLinesView, InboxStrikeView, InboxUnreadView, InboxView } from "./inboxTypes.ts";

const KEY = string({ maxLength: 200 });
const ID = string({ maxLength: 160 });
const NAME = string({ maxLength: 256 });
const TIMESTAMP = string({ maxLength: 64 });
const MS = integer({ min: 0 });
const COUNT = integer({ min: 0, max: 1_000_000 });
const COIN = integer({ min: 0, max: 1_000_000_000 });
const CATEGORY = literal("party_strike", "refugees_arrived", "trip_cap_refilled", "mine_near_cap", "packs_rotated", "party_changed");

/** Refuse any key naming an account id, at any depth of a strike line. */
function refuseAccountIds(v: unknown, path: string): void {
  if (!v || typeof v !== "object") return;
  for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
    if (/accountId$/i.test(k)) throw new ShapeError(`${path}.${k}`, "no account id (PHASE-2 §29)", inner);
    refuseAccountIds(inner, `${path}.${k}`);
  }
}

const defender: Guard<InboxStrikeView["defender"]> = (v, path) => {
  if (v && typeof v === "object" && !Array.isArray(v) && "caravanId" in v) throw new ShapeError(`${path}.caravanId`, "no caravan id of the struck player (PHASE-2 §29)", (v as Record<string, unknown>)["caravanId"]);
  return object({ username: nullable(NAME), caravanName: nullable(NAME), regionId: nullable(ID) })(v, path);
};

const strikeFields: Guard<InboxStrikeView> = object({
  seq: integer({ min: 0 }),
  occurredAt: TIMESTAMP,
  jobId: nullable(ID),
  encounterIndex: nullable(integer({ min: 0, max: 10_000 })),
  outcomeKind: nullable(ID),
  defender,
  coinEarned: COIN,
  coinTransferred: COIN,
  coinDiscardedAtCap: COIN,
  reputationDelta: integer(),
  ladderPointsGained: integer({ min: 0 }),
});

const strikeLine: Guard<InboxStrikeView> = (v, path) => {
  refuseAccountIds(v, path);
  return strikeFields(v, path);
};

const details = {
  party_strike: object({
    count: COUNT,
    held: COUNT,
    overran: COUNT,
    stalemate: COUNT,
    other: COUNT,
    coinEarned: COIN,
    coinTransferred: COIN,
    coinDiscardedAtCap: COIN,
    reputationDelta: integer(),
    ladderPointsGained: integer({ min: 0 }),
    windowStartMs: MS,
    windowEndMs: MS,
    linesIncluded: boolean(),
    strikes: array(strikeLine, { maxLength: 64 }),
    notListed: COUNT,
  }),
  refugees_arrived: object({ caravanId: ID, caravanName: NAME, regionId: ID, arrivedAtMs: MS, currentMenuUnclaimed: boolean() }),
  trip_cap_refilled: object({ available: integer({ min: 0, max: 100 }), cap: integer({ min: 0, max: 100 }), fullAtMs: MS }),
  mine_near_cap: object({ balance: COIN, cap: COIN, atCap: boolean(), thresholdPercent: integer({ min: 0, max: 100 }), ratePerHour: COIN, capReachedAtMs: nullable(MS) }),
  packs_rotated: object({ weekIndex: integer(), startsAtMs: MS, endsAtMs: MS }),
  party_changed: object({ reason: literal("merge", "trip_loss"), carriedOver: COUNT, dropped: COUNT, unitsNow: integer({ min: 0, max: 64 }), empty: boolean() }),
} as const;

const base = object({ key: KEY, category: CATEGORY, version: integer({ min: 0 }), occurredAtMs: MS, occurredAt: TIMESTAMP, unread: boolean() });

export const inboxItemShape: Guard<InboxItemView> = (v, path) => {
  const b = base(v, path);
  const detail = details[b.category]((v as Record<string, unknown>)["detail"], `${path}.detail`);
  return { ...b, detail } as InboxItemView;
};

const inboxFields = {
  items: array(inboxItemShape, { maxLength: 256 }),
  unreadCount: COUNT,
  preferences: array(object({ category: CATEGORY, enabled: boolean(), defaultEnabled: boolean() }), { maxLength: 16 }),
  olderStrikes: nullable(object({ batchesPastLimit: COUNT, beforeHorizon: boolean() })),
  strikeBatchWindowMs: integer({ min: 1 }),
  horizonMs: integer({ min: 1 }),
  delivery: literal("in_app"),
} as const;

export const inboxShape: Guard<InboxView> = object(inboxFields);

export const inboxMarkResultShape: Guard<InboxMarkResult> = object({ ...inboxFields, ignored: array(KEY, { maxLength: 256 }) });

export const inboxStrikeLinesShape: Guard<InboxStrikeLinesView> = object({ window: integer({ min: 0 }), strikes: array(strikeLine, { maxLength: 64 }) });

export const inboxUnreadShape: Guard<InboxUnreadView> = object({ unreadCount: COUNT });
