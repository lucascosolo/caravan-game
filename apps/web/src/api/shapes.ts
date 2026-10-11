/**
 * The shapes of every response this client reads, as guards (see shape.ts) typed against
 * the interfaces in types.ts. `createApi` runs the matching guard on every body, so a
 * screen only ever sees a value of the declared type or an `ApiError(0, "bad_payload")`.
 *
 * Bounds are generous ceilings, not balance: they exist so a corrupt number cannot size a
 * render (a tier builds a row of the graph) or an unbounded list cannot stall the page.
 */
import { GRID_HEIGHT, GRID_WIDTH, formationFromJson, isEntryEdge, isTargetingStance, manifestFromJson, partyConfigFromJson, type PartyScoutView, type ScoutSiege, type ScoutUnit } from "@caravan/circle";
import { abilityDisplay, getSiegeType, getUnitType, isAbilityArchetype, isCosmeticKind, isAffinityCategory, mergeStatMult, type Ability, type AbilityDisplay, type Fixed, type Millis, type SiegeCounter } from "@caravan/content";
import { ShapeError, array, boolean, integer, literal, nullable, object, optional, string, type Guard } from "./shape.ts";
import type {
  AcquiredView,
  AuthResponse,
  BandView,
  CandidateMenuResponse,
  CandidateMenuView,
  CandidateView,
  ChoiceView,
  EconomyView,
  FormationResponse,
  FormationView,
  InventoryStatusView,
  IssueView,
  ManifestResponse,
  ManifestView,
  MeResponse,
  MergePreview,
  MergeResultView,
  PartyFeedPage,
  PartyResponse,
  PartyView,
  PoolProgressView,
  ProgressionResponse,
  RecruitResult,
  RecruitView,
  RefugeeClaimResult,
  RefugeeMenuView,
  RefugeeOfferView,
  RefugeeRefreshResult,
  RefugeeRerollResult,
  RefugeeView,
  RosterEntryView,
  SpendResult,
  UnitInstanceView,
  UnitStatsView,
  UnitTypeSummaryView,
  UnlockNodeView,
  UnlockPoints,
  UnlockWebView,
  UnlocksResponse,
  CatalogCosmeticView,
  CosmeticInfoView,
  CosmeticsView,
  EquipResult,
  OwnedCosmeticView,
  PackContentView,
  PackOfferBaseView,
  PackOfferView,
  PackPurchaseView,
  PurchaseResult,
  PurchasesList,
  StoreOverflowView,
  StoreView,
  UnequipResult,
  UpcomingWeekView,
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

/** Chunk 30: a guest has no username; `guest` says so explicitly. */
// Optional only so pre-chunk-30 fixtures read; the server always sends it (the contract fixtures carry it).
const account = object({ id: ID, username: nullable(NAME), guest: optional(boolean()) });

/** A roster row as `GET /me` lists it (chunk 17 reads the roster and the caravan's state from here). */
const unitInstance: Guard<UnitInstanceView> = object({ id: ID, caravan_id: ID, unit_type_id: ID, merge_level: integer({ min: 1, max: 5 }) });

export const meShape: Guard<MeResponse> = object({
  account,
  caravans: array(
    object({
      id: ID,
      name: NAME,
      region_id: ID,
      state: optional(literal("in_town", "on_trip")),
      units: optional(array(unitInstance, { maxLength: 10_000 })),
    }),
    { maxLength: 64 },
  ),
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

/**
 * Chunk 12 QA S5: the ability's numbers ready to print, as the server's content computed them
 * (decimal strings or null; `charges` a count). Shown as given, never re-derived.
 */
const DEC = nullable(string({ maxLength: 32 }));
const abilityDisplayShape: Guard<AbilityDisplay> = object({
  archetype: predicate(isAbilityArchetype, "ability archetype"),
  cooldownSeconds: string({ maxLength: 32 }),
  firstUseSeconds: string({ maxLength: 32 }),
  reachCells: DEC,
  damageMultiplier: DEC,
  healPercent: DEC,
  healCeiling: nullable(literal("start_of_fight_hp")),
  charges: nullable(integer({ min: 0, max: 1_000 })),
  buffPercent: DEC,
  buffSeconds: DEC,
  dashCells: DEC,
  fenceHitCapPercent: DEC,
});

const siegeCounter: Guard<SiegeCounter> = (v, path) => {
  object({ kind: literal("fence", "trap"), category: ID })(v, path);
  return v as SiegeCounter;
};

/** A scouted start cell: on THIS lattice, never merely "some integer" (chunk 08 QA N4). */
const scoutCell = object({ x: integer({ min: 0, max: GRID_WIDTH - 1 }), y: integer({ min: 0, max: GRID_HEIGHT - 1 }) });

/** A type id this client's content knows: an unknown one would draw as "?" and hide what it is (QA N4). */
const knownType = (known: (id: string) => unknown, what: string): Guard<string> => (v, path) => {
  const id = ID(v, path);
  if (known(id) === undefined) throw new ShapeError(path, `known ${what} type id`, v);
  return id;
};

const scoutUnitFields = object({
  ref: ID,
  typeId: knownType(getUnitType, "unit"),
  displayName: NAME,
  affinity: predicate(isAffinityCategory, "affinity category"),
  mergeLevel: integer({ min: 1, max: 5 }),
  slotCost: literal(1),
  stance: predicate(isTargetingStance, "targeting stance"),
  edge: predicate(isEntryEdge, "entry edge"),
  cell: scoutCell,
  pos: fixedPoint,
  ratingInUse: literal("offense"),
  offense: integer({ min: 0, max: 1_000_000 }),
  defense: integer({ min: 0, max: 1_000_000 }),
  hp: integer({ min: 0, max: 1_000_000 }),
  damagePerHitMult: optional(fixed({ min: 1, max: 1_000_000 })),
  moveSpeed: fixed({ min: 0 }),
  attackRange: fixed({ min: 0 }),
  attackCooldown: millis({ min: 0 }),
  ability,
  abilityDisplay: optional(abilityDisplayShape),
});

/**
 * `damagePerHitMult` (chunk 08 QA S1) is new in the scout view: a menu stored before it
 * existed lacks it, and the multiplier is then content's own table at that merge level —
 * the same number `scoutUnit` writes today, never a client estimate.
 */
const scoutUnit: Guard<ScoutUnit> = (v, path) => {
  const u = scoutUnitFields(v, path);
  // A menu stored before chunk 12 QA S5 lacks `abilityDisplay`: content's own function, the one `scoutUnit` calls.
  return { ...u, damagePerHitMult: u.damagePerHitMult ?? mergeStatMult(u.mergeLevel), abilityDisplay: u.abilityDisplay ?? abilityDisplay(u.ability, u.attackRange) } as ScoutUnit;
};

const scoutSiege: Guard<ScoutSiege> = object({
  typeId: knownType(getSiegeType, "siege"),
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

// The client view carries NO owner account id (chunk 14 QA N4): display name and authored only.
const candidate: Guard<CandidateView> = object({
  candidateId: ID,
  partyId: ID,
  owner: object({ displayName: NAME, authored: boolean(), flavor: nullable(string({ maxLength: 1024 })) }),
  reputation: object({ rating: integer(), band, gapFromCaravan: integer(), gapBeyondBand: integer({ min: 0 }), sandbagEarnMultiplier: integer({ min: 0 }) }),
  scout: scoutViewShape,
});

const BP = integer({ min: 0, max: 10_000 });

const menuFields = object({
  tripId: ID,
  encounterIndex: integer({ min: 0, max: MAX_ENCOUNTER }),
  searchSeq: integer({ min: 0 }),
  caravan: object({ rating: integer(), ratingPool: literal("living"), band }),
  centre: integer(),
  escalation: object({ applied: integer(), perEncounter: integer(), nextEncounter: integer() }),
  bandWidthUsed: integer({ min: 0 }),
  widened: boolean(),
  // Chunks 14 N5 / 25: whether the menu needed authored parties from OUTSIDE the widest band, and how much of it is authored.
  authoredOutsideBand: boolean(),
  authoredShare: object({ authored: COUNT, of: COUNT, shareBp: BP, maxShareBp: BP }),
  authoredServed: nullable(object({ band: integer(), window: COUNT, served: COUNT, authored: COUNT, weightedDown: boolean() })),
  candidates: array(candidate, { maxLength: 16 }),
  searchedAtMs: integer({ min: 0 }),
  // The reroll is free and gated by time only (GUARDRAILS §2): any other gate is a bad body.
  reroll: object({ gate: literal("time"), cooldownSeconds: integer({ min: 0 }), availableAtMs: integer({ min: 0 }), available: boolean() }),
  chosen: nullable(object({ candidateId: ID, chosenAt: TIMESTAMP })),
});

/** A menu whose `chosen` names a candidate it does not carry would open a formation against nothing (QA N4). */
const menu: Guard<CandidateMenuView> = (v, path) => {
  const m = menuFields(v, path);
  if (m.chosen && !m.candidates.some((c) => c.candidateId === m.chosen!.candidateId)) throw new ShapeError(`${path}.chosen.candidateId`, "one of the menu's candidate ids", m.chosen.candidateId);
  return m;
};

export const menuShape: Guard<CandidateMenuResponse> = object({ menu });

export const choiceShape: Guard<ChoiceView> = object({ menu, chosen: candidate });

// ── Economy & merging (chunk 16 routes), read by the Town tab (chunk 17) ──────────────

/** Coin amounts: a generous ceiling so a corrupt number cannot size a render or a meter. */
const COIN = integer({ min: 0, max: 1_000_000_000 });

/** Exactly `null` (a field the server promises is never set, such as a recruit cooldown). */
const nullOnly: Guard<null> = (v, path) => {
  if (v !== null) throw new ShapeError(path, "null", v);
  return null;
};
const MS = integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const LEVEL = integer({ min: 1, max: 5 });

/** `{ "2": 250, … }`: an object whose every value is a Coin amount (keys are the resulting level). */
const costTable: Guard<Readonly<Record<string, number>>> = (v, path) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ShapeError(path, "object", v);
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = COIN(val, `${path}.${k}`);
  return out;
};

const recipe = object({ spend: integer({ min: 1, max: 64 }), produce: integer({ min: 1, max: 64 }) });

export const economyShape: Guard<EconomyView> = object({
  balance: COIN,
  cap: COIN,
  room: COIN,
  atCap: boolean(),
  trickle: object({
    ratePerHour: COIN,
    msPerCoin: integer({ min: 1 }),
    pending: COIN,
    ledgerBalance: COIN,
    nextCoinInMs: nullable(MS),
    accruedThroughMs: MS,
  }),
  overflow: object({ prospectiveEarn: COIN, wouldCredit: COIN, wouldDiscard: COIN, warn: boolean(), message: string({ maxLength: 1024 }) }),
  earn: object({ encounterSchedule: array(COIN, { maxLength: 64 }), bankedTripBonus: COIN, partyWin: COIN }),
  merge: object({ costPerResultingUnitByLevel: costTable, recipes: array(recipe, { maxLength: 8 }), levelCap: LEVEL, slotCost: integer({ min: 1, max: 64 }) }),
});

const unitStats: Guard<UnitStatsView> = object({
  hp: integer({ min: 0, max: 100_000_000 }),
  offense: integer({ min: 0, max: 1_000_000 }),
  defense: integer({ min: 0, max: 1_000_000 }),
  damageOutputMult: integer({ min: 0 }),
  multDen: integer({ min: 1 }),
  referenceHit: integer({ min: 0, max: 100_000_000 }),
});

export const mergePreviewShape: Guard<MergePreview> = object({
  caravanId: ID,
  unitTypeId: ID,
  unitDisplayName: NAME,
  recipe,
  fromLevel: LEVEL,
  toLevel: LEVEL,
  costPerUnit: COIN,
  totalCost: COIN,
  balance: COIN,
  pendingTrickle: COIN,
  affordable: boolean(),
  consumed: object({
    instanceIds: array(ID, { maxLength: 64 }),
    inParty: array(ID, { maxLength: 64 }),
    count: integer({ min: 1, max: 64 }),
    slots: integer({ min: 0, max: 4096 }),
    perUnit: unitStats,
    combined: unitStats,
  }),
  requiresConfirmInParty: boolean(),
  produced: object({ count: integer({ min: 1, max: 64 }), slots: integer({ min: 0, max: 4096 }), perUnit: unitStats, combined: unitStats }),
  slotsFreed: integer({ min: 0, max: 4096 }),
  ability: object({ archetype: ID, displayName: NAME }),
});

export const mergeResultShape: Guard<MergeResultView> = object({
  replayed: boolean(),
  merged: object({ unitTypeId: ID, fromLevel: LEVEL, toLevel: LEVEL, coinCost: COIN }),
  consumedInstanceIds: array(ID, { maxLength: 64 }),
  producedInstanceIds: array(ID, { maxLength: 64 }),
  produced: array(unitInstance, { maxLength: 64 }),
  balanceAfter: COIN,
});

// ── Unit acquisition (chunk 18 routes), read by the Town tab ─────────────────────────

const unitSummary = { unitTypeId: ID, displayName: NAME, affinity: ID, ability: object({ archetype: ID, displayName: NAME }) };
const unitTypeSummary: Guard<UnitTypeSummaryView> = object(unitSummary);
const inventory: Guard<InventoryStatusView> = object({ count: COUNT, cap: COUNT, room: COUNT, full: boolean() });
const refugeeOffer: Guard<RefugeeOfferView> = object({ ...unitSummary, slot: integer({ min: 0, max: 64 }) });

const refugeeMenu: Guard<RefugeeMenuView> = object({
  sequence: integer({ min: 1, max: 2_147_483_647 }),
  origin: literal("free", "reroll"),
  rerollsThisWindow: integer({ min: 0, max: 100_000 }),
  offers: array(refugeeOffer, { maxLength: 64 }),
  generatedAtMs: MS,
  claimed: nullable(object({ unitTypeId: ID, instanceId: ID, claimedAtMs: MS })),
});

export const refugeeViewShape: Guard<RefugeeView> = object({
  caravanId: ID,
  menu: refugeeMenu,
  timer: object({ intervalMs: integer({ min: 1 }), windowOpenedAtMs: MS, nextFreeRefreshAtMs: MS, msUntilFreeRefresh: MS, freeRefreshDue: boolean(), refreshedNow: boolean() }),
  reroll: object({
    nextCost: COIN,
    nextIndex: integer({ min: 0, max: 100_000 }),
    schedule: array(COIN, { maxLength: 64 }),
    affordable: boolean(),
    forfeitsUnclaimedOffer: boolean(),
    blockedByFreeRefresh: boolean(),
  }),
  balance: COIN,
  pendingTrickle: COIN,
  inventory,
});

const acquired: Guard<AcquiredView> = object({ unitTypeId: ID, instanceId: ID, mergeLevel: LEVEL, source: ID, coinCost: COIN });

export const refugeeClaimShape: Guard<RefugeeClaimResult> = object({ replayed: boolean(), acquired, refugees: refugeeViewShape });
export const refugeeRefreshShape: Guard<RefugeeRefreshResult> = object({
  replayed: boolean(),
  fromSequence: integer({ min: 1, max: 2_147_483_647 }),
  forfeitedOffers: nullable(array(refugeeOffer, { maxLength: 64 })),
  refugees: refugeeViewShape,
});
export const refugeeRerollShape: Guard<RefugeeRerollResult> = object({
  replayed: boolean(),
  fromSequence: integer({ min: 1, max: 2_147_483_647 }),
  coinCost: COIN,
  balanceAfter: COIN,
  refugees: refugeeViewShape,
});

export const recruitViewShape: Guard<RecruitView> = object({
  caravanId: ID,
  costBase: COIN,
  scaling: string({ maxLength: 64 }),
  recruitable: array(object({ ...unitSummary, cost: COIN, affordable: boolean() }), { maxLength: 256 }),
  locked: array(unitTypeSummary, { maxLength: 256 }),
  balance: COIN,
  pendingTrickle: COIN,
  inventory,
  // GUARDRAILS §3 / chunk 18: recruit has no cooldown and no daily limit; a body that says otherwise is a bad body.
  availability: object({ cooldown: nullOnly, dailyLimit: nullOnly }),
});

export const recruitResultShape: Guard<RecruitResult> = object({ replayed: boolean(), acquired, coinCost: COIN, balanceAfter: COIN, inventory });

// ── Standing raid party (chunk 09 routes), the Party tab ─────────────────────────────

const partyConfig = parsedBy(partyConfigFromJson, "party config");
/** A validation issue; `subject` is present only when the server set it (exact optional, so built by hand). */
const issue: Guard<IssueView> = (v, path) => {
  const base = object({ code: ID, message: string({ maxLength: 2048 }) })(v, path);
  const subject = optional(string({ maxLength: 256 }))((v as Record<string, unknown>)["subject"], `${path}.subject`);
  return subject === undefined ? base : { ...base, subject };
};

const rosterEntry: Guard<RosterEntryView> = object({
  instanceId: ID,
  caravanId: ID,
  typeId: ID,
  displayName: NAME,
  mergeLevel: LEVEL,
  slotCost: literal(1),
  offense: integer({ min: 0, max: 1_000_000 }),
  defense: integer({ min: 0, max: 1_000_000 }),
  hp: integer({ min: 0, max: 100_000_000 }),
  unlocked: boolean(),
  inParty: boolean(),
  packedOnTrip: boolean(),
  aliveOnTrip: nullable(boolean()),
});

const siegeCatalogEntry: Guard<ScoutSiege & { readonly unlocked: boolean }> = (v, path) => {
  const s = scoutSiege(v, path);
  const u = object({ unlocked: boolean() })(v, path);
  return { ...s, unlocked: u.unlocked };
};

const partyView: Guard<PartyView> = object({
  id: ID,
  slot: integer({ min: 0, max: 64 }),
  savedAt: TIMESTAMP,
  hash: ID,
  config: partyConfig,
  valid: boolean(),
  issues: array(issue, { maxLength: 1024 }),
  scout: nullable(scoutViewShape),
  edges: array(predicate(isEntryEdge, "entry edge"), { maxLength: 4 }),
  caps: object({ units: COUNT, siege: COUNT, edges: integer({ min: 1, max: 4 }), editCooldownMs: literal(0), partiesPerAccount: integer({ min: 1, max: 64 }) }),
  // The party is a template (GUARDRAILS §0): a body claiming otherwise is a bad body.
  rules: object({
    template: literal(true),
    neverConsumed: literal(true),
    unitsMayAlsoBePackedOnTrips: literal(true),
    ratingInUse: literal("offense"),
    stances: array(predicate(isTargetingStance, "targeting stance"), { maxLength: 8 }),
  }),
  roster: array(rosterEntry, { maxLength: 10_000 }),
  siegeCatalog: array(siegeCatalogEntry, { maxLength: 64 }),
});

export const partyShape: Guard<PartyResponse> = object({ party: partyView });

export const partyFeedShape: Guard<PartyFeedPage> = object({
  entries: array(
    object({
      seq: integer({ min: 0 }),
      occurredAt: TIMESTAMP,
      jobId: nullable(ID),
      encounterIndex: nullable(integer({ min: 0, max: MAX_ENCOUNTER })),
      defender: object({ username: nullable(NAME), caravanName: nullable(NAME), regionId: nullable(ID) }),
      outcomeKind: nullable(ID),
      coinEarned: COIN,
      reputationDelta: integer(),
      ladderPointsGained: integer({ min: 0 }),
    }),
    { maxLength: 256 },
  ),
  nextBefore: integer({ min: 0 }),
  hasMore: boolean(),
});

// ── Store & cosmetics (chunk 20 routes), the Packs and Cosmetics screens ─────────────
//
// Legibility (GUARDRAILS §4) and no pay-to-win (§2) are checked here, not only drawn:
//   - a pack's contents are exactly two kinds, coin | cosmetic, with exactly one coin entry;
//   - the offer's headline `coin` and its `cosmetics` list must AGREE with `contents` (the
//     exact list the purchase grants), so the screen can never show one thing and sell another;
//   - the storefront must say it is the sandbox stub with no real charges: this client's copy
//     says "no real money moves", and a body that claims otherwise is a bad body;
//   - a cosmetic carries no numeric field at all (nothing the guard reads could be a stat).

const PACK_TIER = literal(1, 2, 3);
const HASH = (v: unknown, path: string): string => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new ShapeError(path, "64-char lowercase sha256 hex", v);
  return v;
};
const TEXT = string({ maxLength: 2048 });
const MAX_COSMETICS = 1024;

const cosmeticInfoFields = {
  id: ID,
  kind: predicate(isCosmeticKind, "cosmetic kind"),
  displayName: NAME,
  description: TEXT,
  appliesTo: nullable(ID),
  reviewNote: TEXT,
  slot: ID,
};
const cosmeticInfo: Guard<CosmeticInfoView> = object(cosmeticInfoFields);

const packContent: Guard<PackContentView> = (v, path) => {
  const { kind } = object({ kind: literal("coin", "cosmetic") })(v, path);
  if (kind === "coin") return { kind, amount: integer({ min: 1, max: 1_000_000_000 })((v as Record<string, unknown>)["amount"], `${path}.amount`) };
  return { kind, cosmeticId: ID((v as Record<string, unknown>)["cosmeticId"], `${path}.cosmeticId`) };
};
const packContents: Guard<readonly PackContentView[]> = (v, path) => {
  const list = array(packContent, { maxLength: 16 })(v, path);
  if (list.filter((c) => c.kind === "coin").length !== 1) throw new ShapeError(path, "exactly one coin entry", v);
  return list;
};

const offerBaseFields = {
  id: ID,
  weekIndex: integer({ min: 0 }),
  tier: PACK_TIER,
  priceCents: integer({ min: 0, max: 1_000_000 }),
  priceDisplay: string({ maxLength: 32 }),
  coin: COIN,
  cosmetics: array(cosmeticInfo, { maxLength: 16 }),
  contents: packContents,
  contentsHash: HASH,
};

/** `coin` and `cosmetics` must be exactly what `contents` grants, in the same order. */
function agreeing<T extends PackOfferBaseView>(inner: Guard<T>): Guard<T> {
  return (v, path) => {
    const o = inner(v, path);
    const coin = o.contents.find((c) => c.kind === "coin");
    if (!coin || coin.amount !== o.coin) throw new ShapeError(`${path}.coin`, `the coin entry of contents (${coin?.amount ?? "none"})`, o.coin);
    const granted = o.contents.flatMap((c) => (c.kind === "cosmetic" ? [c.cosmeticId] : []));
    const shown = o.cosmetics.map((c) => c.id);
    if (granted.length !== shown.length || granted.some((id, i) => id !== shown[i])) {
      throw new ShapeError(`${path}.cosmetics`, `the cosmetic entries of contents (${granted.join(", ") || "none"})`, shown.join(", "));
    }
    return o;
  };
}

const storeOverflow: Guard<StoreOverflowView> = object({
  balance: COIN,
  cap: COIN,
  room: COIN,
  prospectiveEarn: COIN,
  wouldCredit: COIN,
  wouldDiscard: COIN,
  atCap: boolean(),
  warn: boolean(),
  message: string({ maxLength: 1024 }),
});

const offerBase: Guard<PackOfferBaseView> = agreeing(object(offerBaseFields));
const offer: Guard<PackOfferView> = agreeing(
  object({ ...offerBaseFields, purchased: boolean(), purchasedAt: nullable(TIMESTAMP), purchaseId: nullable(ID), overflow: storeOverflow }),
);
const upcomingWeek: Guard<UpcomingWeekView> = object({ weekIndex: integer({ min: 0 }), startsAtMs: MS, endsAtMs: MS, offers: array(offerBase, { maxLength: 3 }) });

export const storeShape: Guard<StoreView> = object({
  backend: object({ name: ID, sandbox: literal(true), realCharges: literal(false), message: TEXT }),
  week: object({ index: integer({ min: 0 }), startsAtMs: MS, endsAtMs: MS, nowMs: MS }),
  balance: object({ balance: COIN, cap: COIN, room: COIN, atCap: boolean(), pendingTrickle: COIN }),
  offers: array(offer, { maxLength: 3 }),
  combined: object({ tiers: array(PACK_TIER, { maxLength: 3 }), coin: COIN, overflow: storeOverflow }),
  upcoming: array(upcomingWeek, { maxLength: 8 }),
  ceiling: object({
    weeklyPayCeiling: COIN,
    freeWeeklyEarnEstimate: integer({ min: 1, max: 1_000_000_000 }),
    paidToFreeRatioBp: integer({ min: 0, max: 10_000_000 }),
    paidToFreeRatioMaxBp: integer({ min: 0, max: 10_000_000 }),
    storageCap: COIN,
    purchaseLimitPerTierPerWeek: integer({ min: 1, max: 16 }),
    note: TEXT,
  }),
});

const packPurchase: Guard<PackPurchaseView> = object({
  id: ID,
  weekIndex: integer({ min: 0 }),
  tier: PACK_TIER,
  backend: ID,
  sandboxReceipt: nullable(string({ maxLength: 256 })),
  priceCents: integer({ min: 0, max: 1_000_000 }),
  contents: packContents,
  coin: object({ requested: COIN, credited: COIN, discarded: COIN }),
  purchasedAt: TIMESTAMP,
  settled: boolean(),
});

export const purchaseResultShape: Guard<PurchaseResult> = object({
  sandbox: literal(true),
  replayed: boolean(),
  purchase: packPurchase,
  coin: object({ requested: COIN, credited: COIN, discarded: COIN, balanceAfter: COIN, cap: COIN }),
  cosmeticsGranted: array(ID, { maxLength: 16 }),
  cosmeticsAlreadyOwned: array(ID, { maxLength: 16 }),
});

export const purchasesShape: Guard<PurchasesList> = object({ purchases: array(packPurchase, { maxLength: 100_000 }) });

/** slot → cosmetic id. */
const equipMap: Guard<Readonly<Record<string, string>>> = (v, path) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ShapeError(path, "object", v);
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 64) throw new ShapeError(path, "at most 64 slots", v);
  const out: Record<string, string> = {};
  for (const [slot, id] of entries) out[ID(slot, `${path} key`)] = ID(id, `${path}.${slot}`);
  return out;
};

const ownedCosmetic: Guard<OwnedCosmeticView> = object({ ...cosmeticInfoFields, purchaseId: ID, grantedAt: TIMESTAMP, equipped: boolean() });
const catalogCosmetic: Guard<CatalogCosmeticView> = object({
  ...cosmeticInfoFields,
  owned: boolean(),
  nextOffer: nullable(object({ weekIndex: integer({ min: 0 }), tier: PACK_TIER })),
});

export const cosmeticsShape: Guard<CosmeticsView> = object({
  kinds: array(predicate(isCosmeticKind, "cosmetic kind"), { maxLength: 16 }),
  owned: array(ownedCosmetic, { maxLength: MAX_COSMETICS }),
  equipped: equipMap,
  catalog: array(catalogCosmetic, { maxLength: MAX_COSMETICS }),
});

export const equipResultShape: Guard<EquipResult> = object({ slot: ID, cosmeticId: ID, equipped: equipMap });
export const unequipResultShape: Guard<UnequipResult> = object({ slot: ID, cleared: boolean(), equipped: equipMap });
