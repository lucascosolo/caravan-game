/**
 * The shapes of every response this client reads, as guards (see shape.ts) typed against
 * the interfaces in types.ts. `createApi` runs the matching guard on every body, so a
 * screen only ever sees a value of the declared type or an `ApiError(0, "bad_payload")`.
 *
 * Bounds are generous ceilings, not balance: they exist so a corrupt number cannot size a
 * render (a tier builds a row of the graph) or an unbounded list cannot stall the page.
 */
import { formationFromJson, isEntryEdge, isTargetingStance, manifestFromJson, type PartyScoutView, type ScoutSiege, type ScoutUnit } from "@caravan/circle";
import { isAbilityArchetype, isAffinityCategory, type Ability, type Fixed, type Millis, type SiegeCounter } from "@caravan/content";
import { ShapeError, array, boolean, integer, literal, nullable, object, string, type Guard } from "./shape.ts";
import type {
  AuthResponse,
  BandView,
  CandidateMenuResponse,
  CandidateMenuView,
  CandidateView,
  ChoiceView,
  FormationResponse,
  FormationView,
  ManifestResponse,
  ManifestView,
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

// ── Wagon circle (chunk 07 routes), read by the Trail tab (chunk 08) ──────────────────

/** Largest encounter index the client will number; a trip is a handful of encounters. */
const MAX_ENCOUNTER = 10_000;
const COUNT = integer({ min: 0, max: 100_000 });
const TIMESTAMP = string({ maxLength: 64 });

/**
 * A body that @caravan/circle parses itself: its strict parsers (unknown keys, floats and
 * off-lattice cells refused; canonical order) ARE the guard for the two structures they
 * know. A refusal becomes a ShapeError at this path, carrying the parser's reason.
 */
const parsedBy = <T>(parse: (raw: unknown) => T, what: string): Guard<T> => (v, path) => {
  try {
    return parse(v);
  } catch (err) {
    throw new ShapeError(path, `${what} (${err instanceof Error ? err.message : String(err)})`, v);
  }
};

/** A value accepted by a type predicate the content/circle packages export. */
const predicate = <T>(is: (v: unknown) => v is T, expected: string): Guard<T> => (v, path) => {
  if (!is(v)) throw new ShapeError(path, expected, v);
  return v;
};

const manifestBody = parsedBy(manifestFromJson, "manifest body");
const formationBody = parsedBy(formationFromJson, "formation body");

const manifestView: Guard<ManifestView> = object({
  id: ID,
  caravanId: ID,
  encountersResolved: integer({ min: 0, max: MAX_ENCOUNTER }),
  createdAt: TIMESTAMP,
  closedAt: nullable(TIMESTAMP),
  packed: manifestBody,
  survivors: manifestBody,
  summary: object({
    unitsAlive: COUNT,
    unitsDead: COUNT,
    trapsUnspent: COUNT,
    trapsSpent: COUNT,
    fencesIntact: COUNT,
    fencesDestroyed: COUNT,
  }),
  formations: array(object({ encounterIndex: integer({ min: 0, max: MAX_ENCOUNTER }), hash: ID, committedAt: nullable(TIMESTAMP) }), { maxLength: MAX_ENCOUNTER }),
});

export const manifestShape: Guard<ManifestResponse> = object({ manifest: manifestView });

const formationView: Guard<FormationView> = object({
  manifestId: ID,
  encounterIndex: integer({ min: 0, max: MAX_ENCOUNTER }),
  formation: formationBody,
  hash: ID,
  gaps: array(integer({ min: 0, max: 1024 }), { maxLength: 1024 }),
  committedAt: nullable(TIMESTAMP),
});

export const formationShape: Guard<FormationResponse> = object({ formation: formationView });

// ── Matchmaking & scouting (chunk 14 routes) ─────────────────────────────────────────

/** Content's branded integers: the same check as `integer`, typed as the brand. */
const fixed = (opts: { readonly min?: number; readonly max?: number } = {}): Guard<Fixed> => (v, path) => integer(opts)(v, path) as Fixed;
const millis = (opts: { readonly min?: number; readonly max?: number } = {}): Guard<Millis> => (v, path) => integer(opts)(v, path) as Millis;

const cell = object({ x: integer({ min: 0, max: 1024 }), y: integer({ min: 0, max: 1024 }) });
const fixedPoint = object({ x: fixed(), y: fixed() });

/**
 * An ability is content, not state: the archetype and the three fields every archetype
 * carries are checked, the archetype-specific numbers pass through for the stat block.
 */
const ability: Guard<Ability> = (v, path) => {
  object({ archetype: predicate(isAbilityArchetype, "ability archetype"), displayName: NAME, description: string({ maxLength: 1024 }), cooldown: millis({ min: 0 }) })(v, path);
  return v as Ability;
};

const siegeCounter: Guard<SiegeCounter> = (v, path) => {
  object({ kind: literal("fence", "trap"), category: ID })(v, path);
  return v as SiegeCounter;
};

const scoutUnit: Guard<ScoutUnit> = object({
  ref: ID,
  typeId: ID,
  displayName: NAME,
  affinity: predicate(isAffinityCategory, "affinity category"),
  mergeLevel: integer({ min: 1, max: 5 }),
  slotCost: literal(1),
  stance: predicate(isTargetingStance, "targeting stance"),
  edge: predicate(isEntryEdge, "entry edge"),
  cell,
  pos: fixedPoint,
  ratingInUse: literal("offense"),
  offense: integer({ min: 0, max: 1_000_000 }),
  defense: integer({ min: 0, max: 1_000_000 }),
  hp: integer({ min: 0, max: 1_000_000 }),
  moveSpeed: fixed({ min: 0 }),
  attackRange: fixed({ min: 0 }),
  attackCooldown: millis({ min: 0 }),
  ability,
});

const scoutSiege: Guard<ScoutSiege> = object({
  typeId: ID,
  displayName: NAME,
  counters: siegeCounter,
  effect: literal("accelerates", "bypasses"),
  fenceDamageMult: nullable(fixed({ min: 0 })),
  nullifiesTrap: boolean(),
  targetTypeIds: array(ID, { maxLength: 64 }),
});

const slots = object({ used: COUNT, cap: COUNT });

export const scoutViewShape: Guard<PartyScoutView> = object({
  v: literal(1),
  units: array(scoutUnit, { maxLength: 64 }),
  siege: array(scoutSiege, { maxLength: 64 }),
  edges: array(predicate(isEntryEdge, "entry edge"), { maxLength: 4 }),
  unitSlots: slots,
  siegeSlots: slots,
});

const band: Guard<BandView> = object({ index: integer(), low: integer(), high: integer() });

const candidate: Guard<CandidateView> = object({
  candidateId: ID,
  partyId: ID,
  owner: object({ accountId: ID, displayName: NAME, authored: boolean() }),
  reputation: object({ rating: integer(), band, gapFromCaravan: integer(), sandbagEarnMultiplier: integer({ min: 0 }) }),
  scout: scoutViewShape,
});

const menu: Guard<CandidateMenuView> = object({
  tripId: ID,
  encounterIndex: integer({ min: 0, max: MAX_ENCOUNTER }),
  searchSeq: integer({ min: 0 }),
  caravan: object({ rating: integer(), ratingPool: literal("living"), band }),
  centre: integer(),
  escalation: object({ applied: integer(), perEncounter: integer(), nextEncounter: integer() }),
  bandWidthUsed: integer({ min: 0 }),
  widened: boolean(),
  usedAuthoredFallback: boolean(),
  candidates: array(candidate, { maxLength: 16 }),
  searchedAtMs: integer({ min: 0 }),
  // The reroll is free and gated by time only (GUARDRAILS §2): any other gate is a bad body.
  reroll: object({ gate: literal("time"), cooldownSeconds: integer({ min: 0 }), availableAtMs: integer({ min: 0 }), available: boolean() }),
  chosen: nullable(object({ candidateId: ID, chosenAt: TIMESTAMP })),
});

export const menuShape: Guard<CandidateMenuResponse> = object({ menu });

export const choiceShape: Guard<ChoiceView> = object({ menu, chosen: candidate });
