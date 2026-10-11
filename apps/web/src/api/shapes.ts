/**
 * The shapes of every response this client reads, as guards (see shape.ts) typed against
 * the interfaces in types.ts. `createApi` runs the matching guard on every body, so a
 * screen only ever sees a value of the declared type or an `ApiError(0, "bad_payload")`.
 *
 * Bounds are generous ceilings, not balance: they exist so a corrupt number cannot size a
 * render (a tier builds a row of the graph) or an unbounded list cannot stall the page.
 */
import { array, boolean, integer, literal, nullable, object, string, type Guard } from "./shape.ts";
import type {
  AuthResponse,
  MeResponse,
  PoolProgressView,
  ProgressionResponse,
  SpendResult,
  UnlockNodeView,
  UnlockPoints,
  UnlockWebView,
  UnlocksResponse,
} from "./types.ts";

/** Largest tier the client will lay out as a row. The authored webs stop at 4. */
export const MAX_TIER = 32;
const MAX_POINTS = 1_000_000;
const ID = string({ maxLength: 128 });
const NAME = string({ maxLength: 256 });

const pool = literal("living", "trap", "siege");
const scope = literal("account", "caravan");

const points: Guard<UnlockPoints> = object({
  granted: integer({ min: 0, max: MAX_POINTS }),
  spent: integer({ min: 0, max: MAX_POINTS }),
  available: integer({ min: 0, max: MAX_POINTS }),
});

const node: Guard<UnlockNodeView> = object({
  id: ID,
  tier: integer({ min: 0, max: MAX_TIER }),
  cost: integer({ min: 0, max: MAX_POINTS }),
  requires: array(ID, { maxLength: 64 }),
  starting: boolean(),
  reached: boolean(),
  prerequisitesMet: boolean(),
  affordable: boolean(),
  missing: array(ID, { maxLength: 64 }),
});

const web: Guard<UnlockWebView> = object({
  id: ID,
  pool,
  scope,
  regionId: nullable(ID),
  accountId: ID,
  caravanId: nullable(ID),
  points,
  nodes: array(node, { maxLength: 512 }),
});

export const unlocksShape: Guard<UnlocksResponse> = object({ webs: array(web, { maxLength: 64 }) });

const poolProgress: Guard<PoolProgressView> = object({
  pool,
  scope,
  accountId: nullable(ID),
  caravanId: nullable(ID),
  reputation: integer(),
  ladder: object({
    level: integer({ min: 0, max: 1000 }),
    points: integer({ min: 0 }),
    cap: integer({ min: 0, max: 1000 }),
    capped: boolean(),
    nextRungAt: nullable(integer({ min: 0 })),
    pointsToNextRung: nullable(integer({ min: 0 })),
    nextRungUnlockPoints: nullable(integer({ min: 0, max: MAX_POINTS })),
  }),
  unlockPoints: points,
});

export const progressionShape: Guard<ProgressionResponse> = object({ pools: array(poolProgress, { maxLength: 64 }) });

const account = object({ id: ID, username: NAME });

export const meShape: Guard<MeResponse> = object({
  account,
  caravans: array(object({ id: ID, name: NAME, region_id: ID }), { maxLength: 64 }),
});

export const authShape: Guard<AuthResponse> = object({ token: string({ maxLength: 4096 }), expiresAt: string({ maxLength: 64 }), account });

export const spendResultShape: Guard<SpendResult> = object({
  created: boolean(),
  webId: ID,
  pool,
  node,
  points,
  nodes: array(node, { maxLength: 512 }),
});
