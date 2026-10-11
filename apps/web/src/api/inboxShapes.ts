/**
 * Guards for the inbox routes (chunk 29), typed against inboxTypes.ts. Same rules as shapes.ts:
 * lists bounded, numbers bounded where they size a render, extra fields ignored. An item of a
 * category this client does not know is refused (bad_payload), never drawn half-understood.
 *
 * The strike's defender is checked to carry no `accountId`: the server must never send one
 * (PHASE-2 §29), and a client that would quietly accept one would hide the leak.
 */
import { ShapeError, array, boolean, integer, literal, nullable, object, string, type Guard } from "./shape.ts";
import type { InboxItemView, InboxStrikeView, InboxUnreadView, InboxView } from "./inboxTypes.ts";

const KEY = string({ maxLength: 200 });
const ID = string({ maxLength: 160 });
const NAME = string({ maxLength: 256 });
const TIMESTAMP = string({ maxLength: 64 });
const MS = integer({ min: 0 });
const COUNT = integer({ min: 0, max: 1_000_000 });
const COIN = integer({ min: 0, max: 1_000_000_000 });
const CATEGORY = literal("party_strike", "refugees_arrived", "trip_cap_refilled", "mine_near_cap", "packs_rotated");

const defender: Guard<InboxStrikeView["defender"]> = (v, path) => {
  if (v && typeof v === "object" && !Array.isArray(v) && "accountId" in v) throw new ShapeError(`${path}.accountId`, "no account id (PHASE-2 §29)", (v as Record<string, unknown>)["accountId"]);
  return object({ username: nullable(NAME), caravanName: nullable(NAME), regionId: nullable(ID) })(v, path);
};

const strikeLine: Guard<InboxStrikeView> = object({
  seq: integer({ min: 0 }),
  occurredAt: TIMESTAMP,
  jobId: nullable(ID),
  encounterIndex: nullable(integer({ min: 0, max: 10_000 })),
  outcomeKind: nullable(ID),
  defender,
  coinEarned: COIN,
  coinTransferred: COIN,
  reputationDelta: integer(),
  ladderPointsGained: integer({ min: 0 }),
});

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
    strikes: array(strikeLine, { maxLength: 64 }),
    notListed: COUNT,
  }),
  refugees_arrived: object({ caravanId: ID, caravanName: NAME, regionId: ID, arrivedAtMs: MS, currentMenuUnclaimed: boolean() }),
  trip_cap_refilled: object({ available: integer({ min: 0, max: 100 }), cap: integer({ min: 0, max: 100 }), fullAtMs: MS }),
  mine_near_cap: object({ balance: COIN, cap: COIN, atCap: boolean(), thresholdPercent: integer({ min: 0, max: 100 }), ratePerHour: COIN, capReachedAtMs: nullable(MS) }),
  packs_rotated: object({ weekIndex: integer(), startsAtMs: MS, endsAtMs: MS }),
} as const;

const base = object({ key: KEY, category: CATEGORY, version: integer({ min: 0 }), occurredAtMs: MS, occurredAt: TIMESTAMP, unread: boolean() });

export const inboxItemShape: Guard<InboxItemView> = (v, path) => {
  const b = base(v, path);
  const detail = details[b.category]((v as Record<string, unknown>)["detail"], `${path}.detail`);
  return { ...b, detail } as InboxItemView;
};

export const inboxShape: Guard<InboxView> = object({
  items: array(inboxItemShape, { maxLength: 256 }),
  unreadCount: COUNT,
  preferences: array(object({ category: CATEGORY, enabled: boolean(), defaultEnabled: boolean() }), { maxLength: 16 }),
  strikeBatchWindowMs: integer({ min: 1 }),
  horizonMs: integer({ min: 1 }),
  delivery: literal("in_app"),
});

export const inboxUnreadShape: Guard<InboxUnreadView> = object({ unreadCount: COUNT });
