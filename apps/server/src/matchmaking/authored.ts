/**
 * Authored cold-start parties (chunk 25, PHASE-2 §25; chunk 14 built the seam). A pool that
 * is never empty: system accounts, flagged `account.is_system`, each owning an ORDINARY
 * standing party — the same rows, the same resolve, the same snapshot, the same scout view
 * as any player's. Matchmaking reads the flag only to retire them by ratio (band.ts:
 * the draw-pool cap and the served-share weight); nothing downstream of selection can tell
 * them apart, and the resolver sees the same shape (tests compare the snapshots).
 *
 * THE SET. AUTHORED_PARTIES_PER_BAND (12) parties in every display band from the one that
 * holds REPUTATION_FLOOR to the one that holds AUTHORED_REPUTATION_CEILING — the band list
 * is derived from the tunables, never written down. Within a band the twelve cover every
 * region's roster (three each), every approach-edge split (1, 2 and 4 edges, each per
 * region), every targeting stance (three all-one-stance patterns plus a mixed one), and a
 * siege loadout drawn from a ladder of combos that grows with the band until every piece
 * has appeared. Size, merge level and unit tier rise with the band: band 0 is three or four
 * unmerged starting units, the top band is eight units at level 4–5 with the region's
 * tier-4 capstone. Every outfit has a human-readable name and one-line flavour
 * (authoredOutfits.ts); its username is `sys_outfit_<slug>`.
 *
 * NO BYPASS (GUARDRAILS §3). The unlock web is the only access gate and a system account
 * gets no exception: every non-starting type a party fields is REACHED the ordinary way —
 * the seed grants the ladder rungs (ledger `ladder_progress_gained` + `unlock_points_granted`,
 * the same events a fight would append) and spends the points through `spendUnlockPoints`.
 * A spec whose types cannot be reached within a capped ladder's points is refused at load.
 * Ratings go through the ledger too (`reputation_changed`, chunk 14 QA S5), so a projection
 * rebuild of a system account equals its live rows.
 *
 * THE OWNERS are unmistakably system: `is_system` (set at creation, before the account owns
 * anything; migration 011 makes it permanent), login refused (routes/auth.ts), the
 * `sys_outfit_` prefix reserved at registration, zero Coin (no credit path can reach them:
 * economy/systemAccount.ts and the migration 011 ledger trigger). Coin lost to an authored
 * party is destroyed, Coin it would earn is never minted (chunk 19). Reputation shifts from
 * a fight apply to the player only.
 *
 * CONTENT DROPS (PHASE-2 §41). `seedAuthoredParties` is idempotent and versioned: each
 * system account's `authored_party` row records AUTHORED_SET_VERSION and the hash of the
 * spec it was built to; a changed spec is applied IN PLACE (rating delta through the
 * ledger, further rungs and nodes, roster rebuilt, party re-saved). Bump the version when
 * the set changes meaning; the hash catches every change regardless, and a live siege
 * rating that drifted from the spec's is re-applied too (chunk 25 QA S8). A drop is checked
 * WHOLE before anything is written (QA S2): nodes already reached stay reached (unlock
 * rights are permanent), so every changed party's reached ∪ new nodes must fit one capped
 * ladder per pool, or the whole drop is refused and nothing changes.
 *
 * ROSTERS through the ledger (chunk 25 QA D3): every instance a system account's caravan
 * gets is appended as `unit_acquired { source: "authored_set" }`, and every instance an
 * update retires as `unit_retired { reason: "authored_set_update" }` — a dedicated removal
 * type, deliberately NOT `unit_lost_on_wipe`: a content update is not a trip loss, and chunk
 * 19 counts only `unit_lost_on_wipe`. `rebuildAuthoredRoster` folds those events and must
 * equal the live rows.
 *
 * IDS. A system account's standing party id is derived from its username
 * (`authoredPartyId`), so the same set seeds the same party ids in every database and a
 * draw over authored parties replays identically everywhere (chunk 25 QA N6).
 */
import {
  REGION_IDS,
  TUNABLES,
  SIEGE_TYPES,
  findUnlockNode,
  nodeCost,
  pointsPerPoolAtLadderCap,
  unlockWebFor,
  type RegionId,
  type UnlockNode,
  type UnlockPool,
  type UnlockWeb,
} from "@caravan/content";
import { TARGETING_STANCES, entryBand, type EntryEdge, type PartyConfig, type TargetingStance } from "@caravan/circle";
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { hashPassword } from "../auth/password.js";
import { withTransaction, type Queryable } from "../db/pool.js";
import type { LedgerEventDraft, UnitRetiredPayload } from "../ledger/events.js";
import { appendEvents, lockAccountForAppend } from "../ledger/ledger.js";
import { saveParty } from "../party/service.js";
import { pointsToRung, unlockPointsForRung, LADDER_CAP } from "../progression/ladder.js";
import { createAccount, createHomeTown, findAccountByUsername } from "../repo/accounts.js";
import { ACCOUNT_POOLS, createAccountPoolProgress, getAccountPoolProgress, getCaravanPoolProgress } from "../repo/poolProgress.js";
import { createUnitInstance } from "../repo/unitInstances.js";
import { createCaravanForAccount } from "../services/caravans.js";
import { purchasedNodeIds } from "../unlocks/access.js";
import { spendUnlockPoints } from "../unlocks/spend.js";
import { AUTHORED_OUTFITS, type AuthoredOutfit } from "./authoredOutfits.js";
import { bandCentre, bandOf } from "./band.js";
import { SYSTEM_USERNAME_PREFIX, systemUsernamePrefixSql } from "./reservedUsername.js";

export const AUTHORED_USERNAME_PREFIX = SYSTEM_USERNAME_PREFIX;
/**
 * Bump when the set changes meaning (a content drop); the spec hash catches every change regardless.
 * v3 (chunk 25 QA N5): bands no longer pair up on (max living tier, base merge level).
 * v4 (chunk 37 balance pass): the difficulty curve re-authored to rise from unmerged three-raider
 * starter outfits at the floor (party size, merge level and leaders on their own curves).
 * v5 (final play-test review, BALANCE-LOG pass 2): the floor band's 1- and 2-edge outfits field
 * AUTHORED_FLOOR_BAND_PARTY_SIZE (2) raiders, so a first trip that leaves GUIDE_RESERVE units in
 * town still holds ≥ 70 % of guided first fights.
 * v6 (final play-test review r3 D2, BALANCE-LOG pass 6): the outliers re-authored (AUTHORED_REAUTHORED).
 */
export const AUTHORED_SET_VERSION = 6;
export const AUTHORED_PARTIES_PER_BAND: number = TUNABLES.AUTHORED_PARTIES_PER_BAND;
if (!Number.isInteger(AUTHORED_PARTIES_PER_BAND) || AUTHORED_PARTIES_PER_BAND < 12) throw new Error("TUNABLES.AUTHORED_PARTIES_PER_BAND must be an integer of at least 12 (PHASE-2 §25)");
if (!Number.isInteger(TUNABLES.AUTHORED_REPUTATION_CEILING) || TUNABLES.AUTHORED_REPUTATION_CEILING < TUNABLES.REPUTATION_FLOOR) throw new Error("TUNABLES.AUTHORED_REPUTATION_CEILING must be an integer at or above REPUTATION_FLOOR");

/** The display bands the set covers: from the floor's band to the ceiling's, inclusive. Derived, never listed. */
export function authoredBands(): number[] {
  const first = bandOf(TUNABLES.REPUTATION_FLOOR).index;
  const last = bandOf(TUNABLES.AUTHORED_REPUTATION_CEILING).index;
  const out: number[] = [];
  for (let b = first; b <= last; b++) out.push(b);
  return out;
}
/** How many bands the set covers (chunk 14's name for it; tests loop over it). */
export const AUTHORED_BANDS: number = authoredBands().length;

const EDGES: readonly EntryEdge[] = ["north", "east", "south", "west"];
const EDGE_SPLITS = [1, 2, 4] as const;
export type StancePattern = TargetingStance | "mixed";
const STANCE_PATTERNS: readonly StancePattern[] = [...TARGETING_STANCES, "mixed"];

/**
 * Siege loadouts, in rising order of what they ask of the siege web. Each must be reachable
 * within one capped ladder (validated below). A band may use a loadout whose deepest node
 * tier is at most `maxSiegeTier(band)`. Content, not balance; tunable in place.
 */
const SIEGE_LOADOUTS: readonly (readonly string[])[] = [
  [],
  ["siege.battering_wagon"],
  ["siege.bridging_planks"],
  ["siege.battering_wagon", "siege.bridging_planks"],
  ["siege.fence_cutters"],
  ["siege.bridging_planks", "siege.dousing_wagon"],
  ["siege.battering_wagon", "siege.bridging_planks", "siege.fence_cutters"],
  ["siege.fence_cutters", "siege.dousing_wagon"],
  ["siege.battering_wagon", "siege.fence_cutters", "siege.dousing_wagon"],
  ["siege.bridging_planks", "siege.fence_cutters", "siege.dousing_wagon"],
  ["siege.blasting_crate"],
  ["siege.battering_wagon", "siege.blasting_crate", "siege.bridging_planks"],
];

export interface AuthoredPartySpec {
  username: string;
  outfit: AuthoredOutfit;
  band: number;
  /** The owner's siege Reputation. */
  rating: number;
  regionId: RegionId;
  units: { typeId: string; mergeLevel: number }[];
  siege: string[];
  edgeCount: (typeof EDGE_SPLITS)[number];
  /** Which entry edges the party uses, in unit-cycling order. */
  edges: EntryEdge[];
  stancePattern: StancePattern;
  /** Non-starting nodes the owner must have reached, in purchase order, and the points they cost. */
  livingNodes: string[];
  livingPoints: number;
  siegeNodes: string[];
  siegePoints: number;
}

// ── web arithmetic (the same functions chunk 05 exposes, composed) ─────────────────────

/** Every node reached once `ids` are reached: the ids plus their transitive prerequisites. */
function closureOf(web: UnlockWeb, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const visit = (id: string): void => {
    if (out.has(id)) return;
    const n = findUnlockNode(web, id);
    if (!n) throw new RangeError(`'${id}' is not a node of web '${web.id}'`);
    out.add(id);
    for (const r of n.requires) visit(r);
  };
  for (const id of ids) visit(id);
  return out;
}

/** The non-starting nodes of a closure in an order every prerequisite precedes its dependant (tier, then id). */
function purchaseOrder(web: UnlockWeb, closure: ReadonlySet<string>): UnlockNode[] {
  const nodes = [...closure].map((id) => findUnlockNode(web, id)!).filter((n) => n.tier > 0);
  nodes.sort((a, b) => a.tier - b.tier || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reached = new Set(web.nodes.filter((n) => n.tier === 0).map((n) => n.id));
  for (const n of nodes) {
    for (const r of n.requires) if (!reached.has(r)) throw new Error(`web '${web.id}': '${n.id}' sorts before its prerequisite '${r}'`);
    reached.add(n.id);
  }
  return nodes;
}

function pointsFor(web: UnlockWeb, nodes: readonly UnlockNode[]): number {
  return nodes.reduce((sum, n) => sum + nodeCost(web, n), 0);
}

/** The ladder rung that first pays out at least `points` unlock points (0 when none are needed). */
export function rungsForPoints(points: number): number {
  if (!Number.isInteger(points) || points < 0) throw new RangeError("points must be a non-negative integer");
  let sum = 0;
  for (let r = 1; r <= LADDER_CAP; r++) {
    if (sum >= points) return r - 1;
    sum += unlockPointsForRung(r);
  }
  if (sum >= points) return LADDER_CAP;
  throw new RangeError(`${points} unlock points exceed what a capped ladder grants (${sum})`);
}

// ── the set ───────────────────────────────────────────────────────────────────────────

/** The last band ordinal (0 when the set has a single band). */
const LAST_ORDINAL = Math.max(1, AUTHORED_BANDS - 1);

/**
 * Chunk 37 balance pass (BALANCE-LOG.md): the outfits' merge level climbs from MERGE_LEVEL_MIN to
 * MERGE_LEVEL_MAX over AUTHORED_CLIMB_BANDS ordinals (6 of the 7), a little faster than a caravan's
 * own progress, so the middle and upper bands field a level above what a caravan there typically
 * packs; the living tier still spreads over every ordinal. validateSpecs: (tier, merge level,
 * raiders in the band) never falls from one band to the next and always rises somewhere.
 */
const CLIMB: number = Math.max(1, Math.min(LAST_ORDINAL, TUNABLES.AUTHORED_CLIMB_BANDS));

/** Deepest living-web tier a band may field: 0 at the floor, UNLOCK_WEB_TIERS in the top band, spread linearly over the ordinals. */
export function maxLivingTier(bandOrdinal: number): number {
  return Math.min(TUNABLES.UNLOCK_WEB_TIERS, Math.floor((bandOrdinal * TUNABLES.UNLOCK_WEB_TIERS) / LAST_ORDINAL));
}
/** Deepest siege-web tier a band may field: siege arrives faster than merged units, so early play shows every piece but the capstone. */
export function maxSiegeTier(bandOrdinal: number): number {
  return Math.min(TUNABLES.UNLOCK_WEB_TIERS, bandOrdinal);
}
/** The merge level a band fields (its leader may be one higher): MERGE_LEVEL_MIN at the floor, MERGE_LEVEL_MAX from ordinal AUTHORED_CLIMB_BANDS up. */
export function baseMergeLevel(bandOrdinal: number): number {
  const steps = TUNABLES.MERGE_LEVEL_MAX - TUNABLES.MERGE_LEVEL_MIN;
  return Math.min(TUNABLES.MERGE_LEVEL_MAX, TUNABLES.MERGE_LEVEL_MIN + Math.floor((bandOrdinal * steps) / CLIMB));
}

/**
 * How many raiders party `i` of a band fields (chunk 37 balance pass, BALANCE-LOG.md): AUTHORED_PARTY_SIZE_FLOOR at
 * the floor, rising by AUTHORED_PARTY_SIZE_RISE over the set (capped at PARTY_SLOT_CAP), the odd
 * parties of a band one ahead of the even ones on the half steps. Never fewer than the edges it splits over.
 */
export function bandPartySize(bandOrdinal: number, i: number): number {
  // Final play-test review (BALANCE-LOG pass 2): the floor band's own size, 0 = on the curve.
  if (bandOrdinal === 0 && TUNABLES.AUTHORED_FLOOR_BAND_PARTY_SIZE > 0) return Math.min(TUNABLES.PARTY_SLOT_CAP, TUNABLES.AUTHORED_FLOOR_BAND_PARTY_SIZE);
  const rise = Math.floor(((2 * bandOrdinal + (i % 2)) * AUTHORED_SIZE_RISE) / (2 * LAST_ORDINAL));
  return Math.min(TUNABLES.PARTY_SLOT_CAP, AUTHORED_SIZE_FLOOR + rise);
}
const AUTHORED_SIZE_FLOOR: number = TUNABLES.AUTHORED_PARTY_SIZE_FLOOR;
const AUTHORED_SIZE_RISE: number = TUNABLES.AUTHORED_PARTY_SIZE_RISE;
const AUTHORED_LEADER_FROM_ORDINAL: number = TUNABLES.AUTHORED_LEADER_FROM_BAND_ORDINAL;
const AUTHORED_FULL_LEVEL_FROM_ORDINAL: number = TUNABLES.AUTHORED_FULL_LEVEL_FROM_BAND_ORDINAL;

export function outfitSlug(name: string): string {
  let slug = name.toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (slug.startsWith("the_")) slug = slug.slice(4);
  const max = 32 - AUTHORED_USERNAME_PREFIX.length; // USERNAME_MAX
  while (slug.length > max) slug = slug.slice(0, slug.lastIndexOf("_"));
  return slug;
}

/**
 * The region's roster for one party: `want` distinct types no deeper than `maxTier`,
 * preferring the deepest, rotated by `offset` so the three parties a region fields in a
 * band differ, greedily keeping the union closure within one capped ladder's points.
 */
function chooseTypes(web: UnlockWeb, maxTier: number, want: number, offset: number): { types: string[]; nodes: UnlockNode[]; points: number } {
  const budget = pointsPerPoolAtLadderCap();
  const candidates = web.nodes.filter((n) => n.tier <= maxTier).sort((a, b) => b.tier - a.tier || (a.id < b.id ? -1 : 1));
  const chosen: string[] = [];
  for (let k = 0; k < candidates.length && chosen.length < want; k++) {
    const c = candidates[(offset + k) % candidates.length]!;
    const closure = closureOf(web, [...chosen, c.id]);
    if (pointsFor(web, purchaseOrder(web, closure)) <= budget) chosen.push(c.id);
  }
  const nodes = purchaseOrder(web, closureOf(web, chosen));
  return { types: chosen, nodes, points: pointsFor(web, nodes) };
}

/**
 * TUNABLE CONTENT (final play-test review r3 D2, BALANCE-LOG pass 6): authored outfits re-authored
 * because the BEST of the 76 skilled layouts held their band's typical rosters (and, in bands 0–1,
 * the fresh guided five-post pack) less than 20 % of the time (`scripts/balance/outliers.ts`). Each
 * takes the smallest change measured to clear the bar: a stance pattern (the party keeps its size),
 * else one raider fewer. Keyed by outfit name; every other outfit is derived exactly as before.
 * validateSpecs still holds: every band keeps a party of every stance pattern, and the band
 * difficulty (tier, merge level, raiders in the band) still rises.
 */
export const AUTHORED_REAUTHORED: Readonly<Record<string, { readonly stancePattern?: StancePattern; readonly dropRaiders?: number; readonly addRaiders?: number }>> = {
  // The outliers (each was under 20 %):
  "Hardrock Hirelings": { stancePattern: "nearest" }, // b0: typical 3/8, fresh-5 0/8 (mixed: fresh-5 6/8, and lost pushed encounter 2)
  "Boot Hill Society": { stancePattern: "mixed" }, // b3: 0/8
  "The Cirque Company": { stancePattern: "mixed" }, // b4: 1/8
  "Prairie Doctor's Party": { stancePattern: "mixed", dropRaiders: 1 }, // b5: 0/8
  "Buffalo Hunter Cooperative": { stancePattern: "mixed", addRaiders: 1 }, // b5: 0/8
  "Lumberjack Levy": { dropRaiders: 1 }, // b5 (mixed already): 0/8
  "Copper Canyon Cartel": { dropRaiders: 1 }, // b6: 0/8 (mixed: 1/8)
  "Sand Ridge Wranglers": { stancePattern: "mixed" }, // b6: 0/8
  "Cyclone Cellar Boys": { stancePattern: "nearest" }, // b6 (mixed already; one fewer: 1/8): 0/8
  "The Ocotillo Ring": { stancePattern: "nearest" }, // b6 (mixed, one or two fewer: 0/8): 0/8
  // Bands 5 and 6 made harder again elsewhere, so lifting their outliers does not flatten the
  // difficulty curve (band 5 must stay under the Reputation break-even for the 8 × L3 circle):
  "Coffin Ridge Riders": { stancePattern: "mixed" }, // b5
  "Scorpion Pass Toll": { stancePattern: "mixed" }, // b5
  "Pine Marten Crew": { addRaiders: 1 }, // b5
  "Badwater Toll Company": { stancePattern: "mixed", addRaiders: 1 }, // b5
  "Boulder Field Boys": { stancePattern: "mixed" }, // b6
  "Icefall Irregulars": { stancePattern: "mixed" }, // b6
  "Pack Mule Brigade": { stancePattern: "core" }, // b6
  "Gallows Gulch Gang": { stancePattern: "mixed" }, // b6
  "Dead Man's Draw Outfit": { stancePattern: "mixed" }, // b6
};

let cachedSpecs: AuthoredPartySpec[] | undefined;

/**
 * The authored set, derived deterministically from the tunables and the outfit table so a
 * content drop regenerates it. Validated on first use: every band full, every rating in
 * its band and above the floor, every party reachable within a capped ladder per pool,
 * usernames unique and within USERNAME_MAX, and the whole set covering every region,
 * stance, edge split, siege piece and living type.
 */
export function authoredPartySpecs(): AuthoredPartySpec[] {
  if (cachedSpecs) return cachedSpecs;
  const bands = authoredBands();
  const perRegionPerBand = AUTHORED_PARTIES_PER_BAND / REGION_IDS.length;
  if (!Number.isInteger(perRegionPerBand)) throw new Error("AUTHORED_PARTIES_PER_BAND must be a multiple of the region count");
  const specs: AuthoredPartySpec[] = [];
  const siegeWeb = unlockWebFor("siege");
  bands.forEach((band, ordinal) => {
    for (let i = 0; i < AUTHORED_PARTIES_PER_BAND; i++) {
      const regionId = REGION_IDS[i % REGION_IDS.length]!;
      const nth = Math.floor(i / REGION_IDS.length); // 0..perRegionPerBand-1: which of the region's parties in this band
      const outfit = AUTHORED_OUTFITS[regionId][ordinal * perRegionPerBand + nth];
      if (!outfit) throw new Error(`authoredOutfits.ts needs at least ${bands.length * perRegionPerBand} outfits for region '${regionId}'`);
      const livingWeb = unlockWebFor("living", regionId);
      const roster = chooseTypes(livingWeb, maxLivingTier(ordinal), 2 + Math.floor(ordinal / 2), nth + ordinal);
      const edgeCount = EDGE_SPLITS[nth % EDGE_SPLITS.length]!;
      // At least one unit per edge the party splits across, so a 4-edge party really comes from four sides.
      const size = Math.min(TUNABLES.PARTY_SLOT_CAP, Math.max(edgeCount, bandPartySize(ordinal, i)));
      const base = baseMergeLevel(ordinal);
      const re = AUTHORED_REAUTHORED[outfit.name];
      const fielded = Math.min(TUNABLES.PARTY_SLOT_CAP, Math.max(edgeCount, size - (re?.dropRaiders ?? 0) + (re?.addRaiders ?? 0)));
      const units: { typeId: string; mergeLevel: number }[] = [];
      for (let u = 0; u < fielded; u++) {
        const leader = ordinal >= AUTHORED_LEADER_FROM_ORDINAL && i % 3 === 0 ? 1 : 0;
        const level = u === 0 ? Math.min(TUNABLES.MERGE_LEVEL_MAX, base + leader) : Math.max(TUNABLES.MERGE_LEVEL_MIN, base - (ordinal >= AUTHORED_FULL_LEVEL_FROM_ORDINAL ? 0 : u % 2));
        units.push({ typeId: roster.types[u % roster.types.length]!, mergeLevel: level });
      }
      const loadouts = SIEGE_LOADOUTS.filter((l) => l.every((id) => (findUnlockNode(siegeWeb, id)?.tier ?? Infinity) <= maxSiegeTier(ordinal)));
      const siege = [...loadouts[(i + ordinal) % loadouts.length]!];
      const siegeNodes = purchaseOrder(siegeWeb, closureOf(siegeWeb, siege));
      const r = (band + i) % EDGES.length;
      const edges = edgeCount === 4 ? [...EDGES] : edgeCount === 2 ? [EDGES[r]!, EDGES[(r + 1) % 4]!] : [EDGES[r]!];
      specs.push({
        username: `${AUTHORED_USERNAME_PREFIX}${outfitSlug(outfit.name)}`,
        outfit,
        band,
        rating: bandCentre(band) + (i - Math.floor(AUTHORED_PARTIES_PER_BAND / 2)) * 24,
        regionId,
        units,
        siege,
        edgeCount,
        edges,
        stancePattern: re?.stancePattern ?? STANCE_PATTERNS[(i + ordinal) % STANCE_PATTERNS.length]!,
        livingNodes: roster.nodes.map((n) => n.id),
        livingPoints: roster.points,
        siegeNodes: siegeNodes.map((n) => n.id),
        siegePoints: pointsFor(siegeWeb, siegeNodes),
      });
    }
  });
  validateSpecs(specs, bands);
  cachedSpecs = specs;
  return specs;
}

function validateSpecs(specs: readonly AuthoredPartySpec[], bands: readonly number[]): void {
  const fail = (why: string): never => {
    throw new Error(`authored set invalid: ${why}`);
  };
  const budget = pointsPerPoolAtLadderCap();
  const names = new Set<string>();
  for (const s of specs) {
    if (s.username.length > 32 || names.has(s.username)) fail(`username '${s.username}' is too long or duplicated`);
    names.add(s.username);
    if (bandOf(s.rating).index !== s.band) fail(`${s.username}: rating ${s.rating} is outside band ${s.band}`);
    if (s.rating < TUNABLES.REPUTATION_FLOOR) fail(`${s.username}: rating ${s.rating} is below the floor`);
    if (s.livingPoints > budget || s.siegePoints > budget) fail(`${s.username}: needs more unlock points than a capped ladder grants`);
    const minUnits = s.band === bands[0] && TUNABLES.AUTHORED_FLOOR_BAND_PARTY_SIZE > 0 ? Math.min(3, TUNABLES.AUTHORED_FLOOR_BAND_PARTY_SIZE) : 3;
    if (s.units.length < minUnits || s.units.length > TUNABLES.PARTY_SLOT_CAP) fail(`${s.username}: ${s.units.length} units`);
    if (s.siege.length > TUNABLES.SIEGE_SLOT_CAP) fail(`${s.username}: ${s.siege.length} siege pieces`);
    for (const u of s.units) if (!u.typeId.startsWith(`${s.regionId}.`)) fail(`${s.username}: '${u.typeId}' is not of region ${s.regionId}`);
  }
  for (const b of bands) {
    const inBand = specs.filter((s) => s.band === b);
    if (inBand.length !== AUTHORED_PARTIES_PER_BAND) fail(`band ${b} has ${inBand.length} parties`);
    for (const r of REGION_IDS) {
      const splits = inBand.filter((s) => s.regionId === r).map((s) => s.edgeCount);
      for (const e of EDGE_SPLITS) if (!splits.includes(e)) fail(`band ${b}, region ${r}: no ${e}-edge party`);
    }
    for (const p of STANCE_PATTERNS) if (!inBand.some((s) => s.stancePattern === p)) fail(`band ${b}: no '${p}' stance pattern`);
  }
  for (const name of Object.keys(AUTHORED_REAUTHORED)) if (!specs.some((s) => s.outfit.name === name)) fail(`AUTHORED_REAUTHORED names '${name}', which is not in the set`);
  const allTypes = new Set(specs.flatMap((s) => s.units.map((u) => u.typeId)));
  for (const r of REGION_IDS) for (const n of unlockWebFor("living", r).nodes) if (!allTypes.has(n.id)) fail(`living type '${n.id}' never appears`);
  const allSiege = new Set(specs.flatMap((s) => s.siege));
  for (const t of SIEGE_TYPES) if (!allSiege.has(t.id)) fail(`siege piece '${t.id}' never appears`);
  const top = specs.filter((s) => s.band === bands[bands.length - 1]);
  if (!top.some((s) => s.units.some((u) => u.mergeLevel === TUNABLES.MERGE_LEVEL_MAX))) fail("the top band fields no unit at the merge cap");
  // Chunk 25 QA N5: every band reads as a step up from the one below it.
  // Chunk 37: (max tier, base merge level, raiders in the band) never falls, and at least one of
  // them rises — the floor bands may share a tier and a merge level and differ by party size.
  const raidersIn = (b: number) => specs.filter((s) => s.band === b).reduce((n, s) => n + s.units.length, 0);
  for (let o = 1; o < bands.length; o++) {
    const prev = [maxLivingTier(o - 1), baseMergeLevel(o - 1), raidersIn(bands[o - 1]!)];
    const cur = [maxLivingTier(o), baseMergeLevel(o), raidersIn(bands[o]!)];
    if (cur.some((v, k) => v < prev[k]!) || cur.every((v, k) => v === prev[k]!)) fail(`band ${bands[o]} does not read as a step up from band ${bands[o - 1]}`);
  }
}

/** The PartyConfig for a spec over the instance ids just created (one per spec unit, in order). */
export function authoredPartyConfig(spec: AuthoredPartySpec, instanceIds: readonly string[]): PartyConfig {
  if (instanceIds.length !== spec.units.length) throw new RangeError("one instance id per unit");
  return {
    v: 1,
    units: instanceIds.map((ref, i) => {
      const edge = spec.edges[i % spec.edges.length]!;
      const band = entryBand(edge);
      // Spread along the band with a stride; units may share a cell (they overlap freely), but spread reads better.
      const cell = band[(i * 5 + spec.band * 3 + spec.rating) % band.length]!;
      const stance: TargetingStance = spec.stancePattern === "mixed" ? TARGETING_STANCES[i % TARGETING_STANCES.length]! : spec.stancePattern;
      return { ref, stance, edge, cell };
    }),
    siege: [...spec.siege],
  };
}

/** What `authored_party.spec_hash` records: everything that shapes the stored party. */
export function specHash(spec: AuthoredPartySpec): string {
  const shape = { v: AUTHORED_SET_VERSION, rating: spec.rating, regionId: spec.regionId, units: spec.units, siege: spec.siege, edges: spec.edges, stancePattern: spec.stancePattern, band: spec.band };
  return createHash("sha256").update(JSON.stringify(shape), "utf8").digest("hex");
}

/**
 * The standing party id of a system account: a UUID-shaped digest of its username, the same
 * in every database (chunk 25 QA N6). Party ids order the draw, so this makes a draw over
 * authored parties reproducible across databases, not just within one.
 */
export function authoredPartyId(username: string): string {
  const h = createHash("sha256").update(`caravan:authored-party:${username}`, "utf8").digest("hex");
  // RFC 4122 layout with the version nibble 5 (name-based) and the variant bits 10xx.
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ── rosters through the ledger (chunk 25 QA D3) ───────────────────────────────────────

export interface RosterEntry {
  instanceId: string;
  unitTypeId: string;
  mergeLevel: number;
}

function byInstance(a: RosterEntry, b: RosterEntry): number {
  return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0;
}

/** The live roster of a caravan, sorted by instance id. */
export async function liveRoster(db: Queryable, caravanId: string): Promise<RosterEntry[]> {
  const res = await db.query<{ id: string; unit_type_id: string; merge_level: number }>("SELECT id, unit_type_id, merge_level FROM unit_instance WHERE caravan_id = $1", [caravanId]);
  return res.rows.map((r) => ({ instanceId: r.id, unitTypeId: r.unit_type_id, mergeLevel: r.merge_level })).sort(byInstance);
}

/**
 * The roster a system caravan's ledger describes: `unit_acquired` adds an instance,
 * `unit_retired` removes it, in ledger order. For a system account (no merges, no trips,
 * so no `unit_lost_on_wipe`) this must equal `liveRoster` exactly — the roster counterpart
 * of verifyProjection.
 */
export async function rebuildAuthoredRoster(db: Queryable, caravanId: string): Promise<RosterEntry[]> {
  const res = await db.query<{ event_type: string; payload: { instanceId?: string; unitInstanceId?: string; unitTypeId: string; mergeLevel: number } }>(
    "SELECT event_type, payload FROM ledger_event WHERE caravan_id = $1 AND event_type IN ('unit_acquired', 'unit_retired') ORDER BY seq",
    [caravanId],
  );
  const roster = new Map<string, RosterEntry>();
  for (const ev of res.rows) {
    const { unitTypeId, mergeLevel } = ev.payload;
    if (ev.event_type === "unit_acquired") {
      const instanceId = ev.payload.instanceId!;
      if (roster.has(instanceId)) throw new Error(`roster fold: instance ${instanceId} acquired twice`);
      roster.set(instanceId, { instanceId, unitTypeId, mergeLevel });
    } else {
      const instanceId = ev.payload.unitInstanceId!;
      if (!roster.delete(instanceId)) throw new Error(`roster fold: instance ${instanceId} retired but never acquired`);
    }
  }
  return [...roster.values()].sort(byInstance);
}

// ── the content-drop budget (chunk 25 QA S2) ──────────────────────────────────────────

/** A drop that would need more unlock points than a capped ladder grants, for one or more parties. */
export class AuthoredDropOverBudgetError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`authored set refused, nothing written: ${problems.join("; ")}`);
    this.name = "AuthoredDropOverBudgetError";
  }
}

/**
 * Whether `spec` can be applied to this existing system account within one capped ladder
 * per pool: the points already spent (nodes once reached stay reached) plus the cost of the
 * spec's nodes not yet reached. Returns the problems, empty when it fits. Reads only.
 */
export async function authoredSpecBudgetProblems(db: Queryable, spec: AuthoredPartySpec, accountId: string, caravanId: string): Promise<string[]> {
  const budget = pointsPerPoolAtLadderCap();
  const problems: string[] = [];
  for (const pool of ["living", "siege"] as const) {
    const web = pool === "living" ? unlockWebFor("living", spec.regionId) : unlockWebFor("siege");
    const progress = pool === "living" ? await getCaravanPoolProgress(db, caravanId) : await getAccountPoolProgress(db, accountId, pool);
    if (!progress) throw new Error(`no ${pool} pool_progress for ${accountId}`);
    const purchased = new Set(await purchasedNodeIds(db, pool, { accountId, caravanId: pool === "living" ? caravanId : null }));
    const nodes = pool === "living" ? spec.livingNodes : spec.siegeNodes;
    const extra = nodes.filter((id) => !purchased.has(id)).reduce((sum, id) => sum + nodeCost(web, findUnlockNode(web, id)!), 0);
    const total = progress.unlock_points_spent + extra;
    if (total > budget) problems.push(`${spec.username} ${pool}: ${progress.unlock_points_spent} points already spent + ${extra} for new nodes = ${total} > ${budget} (one capped ladder)`);
  }
  return problems;
}

// ── seeding ───────────────────────────────────────────────────────────────────────────

export interface SeedAuthoredResult {
  version: number;
  created: string[];
  updated: string[];
  existing: string[];
}

/**
 * Grant the ladder rungs that pay out `extraPoints` more unlock points than the owner has
 * spent, for one pool, as the fights would have: one ledger event pair per rung crossed.
 */
async function grantRungs(client: pg.PoolClient, accountId: string, pool: UnlockPool, caravanId: string | null, extraPoints: number, cause: string): Promise<void> {
  const progress = pool === "living" ? await getCaravanPoolProgress(client, caravanId!) : await getAccountPoolProgress(client, accountId, pool);
  if (!progress) throw new Error(`no ${pool} pool_progress for ${accountId}`);
  const have = progress.unlock_points_granted - progress.unlock_points_spent;
  const points = Math.max(0, extraPoints);
  const target = rungsForPoints(progress.unlock_points_spent + points);
  const drafts: LedgerEventDraft[] = [];
  for (let rung = progress.ladder_level + 1; rung <= target; rung++) {
    const scope = pool === "living" ? { accountId, caravanId: caravanId! } : { accountId };
    drafts.push({
      type: "ladder_progress_gained",
      ...scope,
      payload: { pool, pointsDelta: pointsToRung(rung) - pointsToRung(rung - 1), levelsGained: 1, levelBefore: rung - 1, levelAfter: rung, reason: "authored_set" },
    });
    drafts.push({ type: "unlock_points_granted", ...scope, payload: { pool, points: unlockPointsForRung(rung), rung } });
  }
  if (drafts.length === 0) {
    if (have < points) throw new Error(`${accountId} ${pool}: ${points} points needed but only ${have} available and no rung left to grant`);
    return;
  }
  await appendEvents(client, `${cause}:${pool}:rungs`, drafts);
}

/**
 * Bring one system account's party to `spec`, in the caller's transaction: rating delta
 * through the ledger, rungs and nodes as needed, a fresh roster, the party re-saved, the
 * `authored_party` record written. Used for creation and for in-place updates alike;
 * exported so a content-drop change can be exercised in tests.
 */
export async function applyAuthoredSpec(client: pg.PoolClient, spec: AuthoredPartySpec, accountId: string, caravanId: string, cause: string): Promise<void> {
  await lockAccountForAppend(client, accountId);
  // QA S2: refuse before writing anything if the reached ∪ new nodes overflow a capped ladder.
  const problems = await authoredSpecBudgetProblems(client, spec, accountId, caravanId);
  if (problems.length) throw new AuthoredDropOverBudgetError(problems);
  // Rating, through the ledger (chunk 14 QA S5): the delta from where the siege rating stands now.
  const siege = await getAccountPoolProgress(client, accountId, "siege");
  if (!siege) throw new Error(`no siege pool_progress for ${accountId}`);
  if (siege.reputation !== spec.rating) {
    await appendEvents(client, `${cause}:rating`, [
      { type: "reputation_changed", accountId, payload: { pool: "siege", delta: spec.rating - siege.reputation, reason: "authored_set", side: "party", unclamped: spec.rating - siege.reputation, floored: false } },
    ]);
  }
  // Access, the ordinary way: rungs grant points, points reach nodes. Nodes already reached
  // (an earlier version of the set) cost nothing more; only the new ones need rungs.
  const toReach = async (pool: "living" | "siege", nodes: readonly string[]): Promise<number> => {
    const web = pool === "living" ? unlockWebFor("living", spec.regionId) : unlockWebFor("siege");
    const purchased = new Set(await purchasedNodeIds(client, pool, { accountId, caravanId: pool === "living" ? caravanId : null }));
    return nodes.filter((id) => !purchased.has(id)).reduce((sum, id) => sum + nodeCost(web, findUnlockNode(web, id)!), 0);
  };
  await grantRungs(client, accountId, "living", caravanId, await toReach("living", spec.livingNodes), cause);
  for (const nodeId of spec.livingNodes) await spendUnlockPoints(client, accountId, { pool: "living", nodeId, caravanId });
  await grantRungs(client, accountId, "siege", null, await toReach("siege", spec.siegeNodes), cause);
  for (const nodeId of spec.siegeNodes) await spendUnlockPoints(client, accountId, { pool: "siege", nodeId, caravanId: null });
  // Roster: fresh instances for this spec; the party is saved over them, then any older
  // instance goes. Both halves are ledger events (QA D3), so the roster rebuilds from the ledger.
  const before = await liveRoster(client, caravanId);
  const ids: string[] = [];
  const rosterEvents: LedgerEventDraft[] = [];
  for (const u of spec.units) {
    const inst = await createUnitInstance(client, { caravanId, unitTypeId: u.typeId, mergeLevel: u.mergeLevel });
    ids.push(inst.id);
    rosterEvents.push({ type: "unit_acquired", accountId, caravanId, payload: { unitTypeId: inst.unit_type_id, instanceId: inst.id, mergeLevel: inst.merge_level, source: "authored_set", coinCost: 0 } });
  }
  const view = await saveParty(client, accountId, authoredPartyConfig(spec, ids));
  if (!view.valid) throw new Error(`authored party ${spec.username} does not resolve: ${view.issues.map((i) => i.message).join("; ")}`);
  await client.query("DELETE FROM unit_instance WHERE caravan_id = $1 AND NOT (id = ANY($2::uuid[]))", [caravanId, ids]);
  for (const old of before) {
    const retired: UnitRetiredPayload = { unitInstanceId: old.instanceId, unitTypeId: old.unitTypeId, mergeLevel: old.mergeLevel, reason: "authored_set_update" };
    rosterEvents.push({ type: "unit_retired", accountId, caravanId, payload: retired });
  }
  await appendEvents(client, `${cause}:roster`, rosterEvents);
  await client.query(
    `INSERT INTO authored_party (account_id, set_version, spec_hash) VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE SET set_version = EXCLUDED.set_version, spec_hash = EXCLUDED.spec_hash, updated_at = now()`,
    [accountId, AUTHORED_SET_VERSION, specHash(spec)],
  );
}

/**
 * Create every authored party that does not exist yet and bring every existing one up to
 * the current set (idempotent: an account whose recorded spec hash matches is left alone).
 * Each party is created or updated in its own transaction. Runs as the app role (the seed
 * script's connection): everything it writes goes through the ordinary services and the
 * ledger. Refuses, rather than fixes, a `sys_outfit_` account that is not a system account.
 */
/**
 * The causation id for one application of a spec to an account: deterministic from stored
 * state (how many applications this account has seen), so a retried seed cannot re-append
 * and a second content drop gets its own cause.
 */
async function nextAuthoredCause(client: pg.PoolClient, accountId: string, hash: string): Promise<string> {
  const res = await client.query<{ n: string }>("SELECT count(DISTINCT split_part(causation_id, ':', 3))::text AS n FROM ledger_event WHERE account_id = $1 AND causation_id LIKE $2", [accountId, `authored:${accountId}:%`]);
  return `authored:${accountId}:${res.rows[0]!.n}:${hash.slice(0, 16)}`;
}

export interface SeedAuthoredOptions {
  /** The set to seed; defaults to authoredPartySpecs(). Tests pass a modified set to exercise a content drop. */
  specs?: readonly AuthoredPartySpec[];
}

interface SeedPlanEntry {
  spec: AuthoredPartySpec;
  /** Absent: create. Present: update in place (or leave alone when `current`). */
  existing?: { accountId: string; caravanId: string };
  current: boolean;
}

export async function seedAuthoredParties(pool: pg.Pool, options: SeedAuthoredOptions = {}): Promise<SeedAuthoredResult> {
  const out: SeedAuthoredResult = { version: AUTHORED_SET_VERSION, created: [], updated: [], existing: [] };
  await reassertSystemAccounts(pool);
  const specs = options.specs ?? authoredPartySpecs();

  // Plan, reading only. A party is current when its recorded version and spec hash match AND
  // its live siege rating still equals the spec's (QA S8: a drifted rating is re-applied).
  const plan: SeedPlanEntry[] = [];
  for (const spec of specs) {
    const existing = await findAccountByUsername(pool, spec.username);
    if (!existing) {
      plan.push({ spec, current: false });
      continue;
    }
    if (!existing.is_system) throw new Error(`account '${spec.username}' exists but is not a system account; refusing to seed over it`);
    const caravan = await pool.query<{ id: string }>("SELECT id FROM caravan WHERE account_id = $1 ORDER BY created_at LIMIT 1", [existing.id]);
    if (!caravan.rows[0]) throw new Error(`system account '${spec.username}' has no caravan`);
    const rec = await pool.query<{ spec_hash: string; set_version: number }>("SELECT spec_hash, set_version FROM authored_party WHERE account_id = $1", [existing.id]);
    const siege = await getAccountPoolProgress(pool, existing.id, "siege");
    const current = rec.rows[0]?.spec_hash === specHash(spec) && rec.rows[0].set_version === AUTHORED_SET_VERSION && siege?.reputation === spec.rating;
    plan.push({ spec, existing: { accountId: existing.id, caravanId: caravan.rows[0].id }, current });
  }
  // QA S2: the whole drop is checked before ANY write; one party over budget refuses them all.
  const problems: string[] = [];
  for (const p of plan) if (p.existing && !p.current) problems.push(...(await authoredSpecBudgetProblems(pool, p.spec, p.existing.accountId, p.existing.caravanId)));
  if (problems.length) throw new AuthoredDropOverBudgetError(problems);

  // One discarded random secret per run: no system account has a usable password, and one hash is cheaper than a hundred.
  const passwordHash = plan.some((p) => !p.existing) ? await hashPassword(randomBytes(32).toString("base64")) : "";
  for (const { spec, existing, current } of plan) {
    if (existing && current) {
      out.existing.push(spec.username);
      continue;
    }
    if (existing) {
      await withTransaction(pool, async (client) => {
        await applyAuthoredSpec(client, spec, existing.accountId, existing.caravanId, await nextAuthoredCause(client, existing.accountId, specHash(spec)));
      });
      out.updated.push(spec.username);
      continue;
    }
    await withTransaction(pool, async (client) => {
      const account = await createAccount(client, { username: spec.username, passwordHash });
      // Before the account owns anything: migration 011 permits this transition only now.
      await client.query("UPDATE account SET is_system = true WHERE id = $1", [account.id]);
      await createHomeTown(client, account.id);
      // The ordinary standing-party row, with an id derived from the username (QA N6).
      await client.query("INSERT INTO standing_party (id, account_id) VALUES ($1, $2)", [authoredPartyId(spec.username), account.id]);
      for (const p of ACCOUNT_POOLS) await createAccountPoolProgress(client, account.id, p);
      const caravan = await createCaravanForAccount(client, { accountId: account.id, regionId: spec.regionId, name: spec.outfit.name });
      await applyAuthoredSpec(client, spec, account.id, caravan.id, await nextAuthoredCause(client, account.id, specHash(spec)));
    });
    out.created.push(spec.username);
  }
  return out;
}

/**
 * Chunk 14 QA B2: every `sys_outfit_` account must be a system account. One that is not
 * (only possible if the flag was lost outside the migrations, which now refuse that) is
 * re-flagged if the schema allows it — it only does for an account that owns nothing — and
 * otherwise the seed refuses with the offending usernames, never silently continues.
 */
export async function reassertSystemAccounts(db: Queryable): Promise<string[]> {
  // Chunk 25 QA B1: the LITERAL prefix (starts_with), the same predicate registration uses —
  // never LIKE, whose `_` wildcard would also match player names such as `sys0outfit0evil`.
  const rows = await db.query<{ id: string; username: string }>(`SELECT id, username FROM account WHERE ${systemUsernamePrefixSql("$1")} AND NOT is_system`, [AUTHORED_USERNAME_PREFIX]);
  const fixed: string[] = [];
  const refused: string[] = [];
  for (const r of rows.rows) {
    try {
      await db.query("UPDATE account SET is_system = true WHERE id = $1", [r.id]);
      fixed.push(r.username);
    } catch {
      refused.push(r.username);
    }
  }
  if (refused.length) throw new Error(`accounts under the '${AUTHORED_USERNAME_PREFIX}' prefix are not system accounts and cannot be re-flagged: ${refused.join(", ")}`);
  return fixed;
}

/** The outfit behind a system username, for onboarding copy (chunk 24) and the feed. */
export function authoredOutfitFor(username: string): AuthoredOutfit | undefined {
  return authoredPartySpecs().find((s) => s.username === username)?.outfit;
}
