/**
 * Cosmetics (PHASE-2 §28, minimal system built in chunk 20). PURELY VISUAL, by construction:
 *
 *   - This catalog is the ONLY source of cosmetic identity. A cosmetic is an id, a kind, a
 *     display name, what it applies to, and a review note. It has no numeric field at all:
 *     nothing here can be a stat, a radius, a hitbox, a speed or a duration (asserted on load).
 *   - Ownership is ACCOUNT-level (GUARDRAILS §5) — a unit skin is owned by the account and
 *     shows on any caravan that has the type. Equipping is a server-stored client preference.
 *   - No resolver, circle, formation, manifest or party input type carries a cosmetic field;
 *     packages/circle/test/no-cosmetic-field.test.ts pins that at the type level and at
 *     runtime, and scripts/resolver-boundary-check.mjs refuses any import of this module
 *     from the resolver.
 *   - A banner or skin must not change silhouette, footprint, or the readability of type,
 *     stance or ability at scouting zoom. Every entry ships with `reviewNote` saying so.
 *   - No cosmetic is earned from a fight outcome in v1. The weekly rotation (below) is the
 *     only way one is offered, and it is deterministic and identical for every player.
 *
 * Pure data and pure functions: no I/O, no clock, no Math.random, no floats.
 */
import { deepFreeze } from "./freeze.js";
import { TUNABLES } from "./tunables.js";
import { LIVING_UNIT_TYPES } from "./units.js";

export const COSMETIC_KINDS = ["unit_skin", "wagon_skin", "fence_style", "town_decoration", "party_banner"] as const;
export type CosmeticKind = (typeof COSMETIC_KINDS)[number];

export function isCosmeticKind(value: unknown): value is CosmeticKind {
  return typeof value === "string" && (COSMETIC_KINDS as readonly string[]).includes(value);
}

export interface CosmeticType {
  readonly id: string;
  readonly kind: CosmeticKind;
  readonly displayName: string;
  readonly description: string;
  /** For `unit_skin`: the living-unit type it re-skins (every instance of it). Null for every other kind. */
  readonly appliesTo: string | null;
  /** PHASE-2 §28: the review confirming type, stance and ability stay identifiable at scouting zoom. */
  readonly reviewNote: string;
}

const SKIN_NOTE = "Palette and trim only; silhouette, footprint and the ability glyph are the base type's. Identifiable at scouting zoom.";
const BANNER_NOTE = "Drawn in the banner slot beside the party card, never over a unit. Does not cover type, stance or ability.";
const DECOR_NOTE = "Town-only scenery; never drawn on the trail or the battlefield.";
const FENCE_NOTE = "Texture only; segment length, height and the gap rendering are the tier's. Tier remains readable by shape.";
const WAGON_NOTE = "Paint and canopy only; the wagon core's footprint and HP bar are unchanged.";

/** The catalog. Sorted by id so the rotation's permutation runs over a fixed order. */
export const COSMETIC_TYPES: readonly CosmeticType[] = deepFreeze(
  (
    [
      // Unit skins: two per region, on the region's two free starting types, so every account can show one.
      { id: "skin.desert.dust_rider.sunbleached", kind: "unit_skin", displayName: "Sunbleached Dust Rider", description: "Faded duster and a straw hat.", appliesTo: "desert.dust_rider", reviewNote: SKIN_NOTE },
      { id: "skin.desert.well_digger.copper", kind: "unit_skin", displayName: "Copper-Pan Well Digger", description: "A polished copper pan on the pack.", appliesTo: "desert.well_digger", reviewNote: SKIN_NOTE },
      { id: "skin.high_plains.homesteader.calico", kind: "unit_skin", displayName: "Calico Homesteader", description: "Patched calico shirt.", appliesTo: "high_plains.homesteader", reviewNote: SKIN_NOTE },
      { id: "skin.high_plains.prairie_wolf.silver", kind: "unit_skin", displayName: "Silver Prairie Wolf", description: "Silver-grey winter coat.", appliesTo: "high_plains.prairie_wolf", reviewNote: SKIN_NOTE },
      { id: "skin.mountain.grizzly.cinnamon", kind: "unit_skin", displayName: "Cinnamon Grizzly", description: "Reddish-brown pelt.", appliesTo: "mountain.grizzly", reviewNote: SKIN_NOTE },
      { id: "skin.mountain.trapper.beaver_hat", kind: "unit_skin", displayName: "Beaver-Hat Trapper", description: "A tall beaver-felt hat.", appliesTo: "mountain.trapper", reviewNote: SKIN_NOTE },
      { id: "skin.badlands.gunslinger.black_duster", kind: "unit_skin", displayName: "Black-Duster Gunslinger", description: "Long black coat, silver buckle.", appliesTo: "badlands.gunslinger", reviewNote: SKIN_NOTE },
      { id: "skin.badlands.bounty_hunter.tin_star", kind: "unit_skin", displayName: "Tin-Star Bounty Hunter", description: "A dented tin star on the lapel.", appliesTo: "badlands.bounty_hunter", reviewNote: SKIN_NOTE },
      // Wagon skins.
      { id: "wagon.conestoga_white", kind: "wagon_skin", displayName: "Whitetop Conestoga", description: "Bleached canvas over a blue bed.", appliesTo: null, reviewNote: WAGON_NOTE },
      { id: "wagon.red_prairie_schooner", kind: "wagon_skin", displayName: "Red Prairie Schooner", description: "Barn-red bed and brass fittings.", appliesTo: null, reviewNote: WAGON_NOTE },
      { id: "wagon.patched_canvas", kind: "wagon_skin", displayName: "Patched Canvas", description: "A well-travelled, much-mended top.", appliesTo: null, reviewNote: WAGON_NOTE },
      { id: "wagon.circus_stripe", kind: "wagon_skin", displayName: "Circus Stripe", description: "Red and gold striped canopy.", appliesTo: null, reviewNote: WAGON_NOTE },
      // Fence styles.
      { id: "fence_style.weathered_grey", kind: "fence_style", displayName: "Weathered Grey", description: "Sun-greyed timber.", appliesTo: null, reviewNote: FENCE_NOTE },
      { id: "fence_style.fresh_cut_pine", kind: "fence_style", displayName: "Fresh-Cut Pine", description: "Pale, newly split wood.", appliesTo: null, reviewNote: FENCE_NOTE },
      { id: "fence_style.tarred_black", kind: "fence_style", displayName: "Tarred Black", description: "Pitch-painted rails.", appliesTo: null, reviewNote: FENCE_NOTE },
      { id: "fence_style.whitewashed", kind: "fence_style", displayName: "Whitewashed", description: "Lime-washed rails.", appliesTo: null, reviewNote: FENCE_NOTE },
      // Town decorations.
      { id: "town.water_tower", kind: "town_decoration", displayName: "Water Tower", description: "A wooden tower by the mine.", appliesTo: null, reviewNote: DECOR_NOTE },
      { id: "town.windmill", kind: "town_decoration", displayName: "Windmill", description: "A turning steel windmill.", appliesTo: null, reviewNote: DECOR_NOTE },
      { id: "town.bunting", kind: "town_decoration", displayName: "Festival Bunting", description: "Strings of flags across the street.", appliesTo: null, reviewNote: DECOR_NOTE },
      { id: "town.hitching_post", kind: "town_decoration", displayName: "Hitching Post", description: "A rail with a couple of horses.", appliesTo: null, reviewNote: DECOR_NOTE },
      // Party banners (shown on the scouting screen and in the results feed).
      { id: "banner.longhorn_skull", kind: "party_banner", displayName: "Longhorn Skull", description: "A bleached skull on red.", appliesTo: null, reviewNote: BANNER_NOTE },
      { id: "banner.crossed_pickaxes", kind: "party_banner", displayName: "Crossed Pickaxes", description: "Two picks on black.", appliesTo: null, reviewNote: BANNER_NOTE },
      { id: "banner.lone_star", kind: "party_banner", displayName: "Lone Star", description: "A single white star on blue.", appliesTo: null, reviewNote: BANNER_NOTE },
      { id: "banner.rattlesnake_coil", kind: "party_banner", displayName: "Rattlesnake Coil", description: "A coiled snake on sand.", appliesTo: null, reviewNote: BANNER_NOTE },
    ] satisfies CosmeticType[]
  ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
);

const BY_ID: ReadonlyMap<string, CosmeticType> = new Map(COSMETIC_TYPES.map((c) => [c.id, c]));

export function getCosmeticType(id: string): CosmeticType | undefined {
  return BY_ID.get(id);
}
export function isCosmeticId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

/**
 * The equip slot a cosmetic occupies. One cosmetic per slot per account: a unit skin's
 * slot is per unit type (`unit_skin:<typeId>`); every other kind has one slot (its kind).
 */
export function cosmeticEquipSlot(c: CosmeticType): string {
  return c.kind === "unit_skin" ? `unit_skin:${c.appliesTo}` : c.kind;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The weekly rotation. Deterministic: week index → the same cosmetics for everyone.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** FNV-1a, 32-bit, over the UTF-16 code units of `s`. Unsigned 32-bit integer; integer ops only. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function xorshift32(state: number): number {
  let x = state >>> 0;
  if (x === 0) x = 0x9e3779b9;
  x ^= (x << 13) >>> 0;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0;
  return x >>> 0;
}

const U32 = 0x1_0000_0000;

/** Uniform integer in [0, k) by rejection sampling (no modulo bias), with the advanced state. */
function uniformBelow(state: number, k: number): { value: number; state: number } {
  const limit = U32 - (U32 % k);
  let s = state;
  for (;;) {
    s = xorshift32(s);
    if (s < limit) return { value: s % k, state: s };
  }
}

/** The seed for a week's draw: FNV-1a over a fixed tag and the week index. */
export function rotationSeed(weekIndex: number): number {
  if (!Number.isInteger(weekIndex)) throw new RangeError(`weekIndex must be an integer, got ${String(weekIndex)}`);
  return fnv1a32(`cosmetic-rotation:${weekIndex}`);
}

/**
 * Which cosmetics each tier carries in `weekIndex`, as ids, tier 1 first. A seeded
 * Fisher–Yates permutation of the sorted catalog, with the first PACK_COSMETICS_BY_TIER[0]
 * ids going to tier 1, the next to tier 2 and so on — so no cosmetic appears in two tiers
 * of the same week, and the catalog's sorted order (not its authoring order) is what the
 * draw runs over. The same week index gives the same answer in every process on every
 * machine; a server test runs it in two separate Node processes and compares.
 */
export function cosmeticRotationForWeek(weekIndex: number): readonly (readonly string[])[] {
  const counts = TUNABLES.PACK_COSMETICS_BY_TIER;
  const ids = COSMETIC_TYPES.map((c) => c.id);
  let state = rotationSeed(weekIndex);
  for (let i = ids.length - 1; i > 0; i--) {
    const draw = uniformBelow(state, i + 1);
    state = draw.state;
    const j = draw.value;
    const tmp = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = tmp;
  }
  const out: string[][] = [];
  let cursor = 0;
  for (const n of counts) {
    out.push(ids.slice(cursor, cursor + n));
    cursor += n;
  }
  return out;
}

/**
 * The schedule for one cosmetic: the week indices in [fromWeek, fromWeek + horizon) in
 * which it is on offer, each with its tier. "Retired cosmetics may return; the schedule
 * says when" (PHASE-2 §28).
 */
export function cosmeticOfferWeeks(
  cosmeticId: string,
  fromWeek: number,
  horizonWeeks: number,
): readonly { readonly weekIndex: number; readonly tier: number }[] {
  if (!Number.isInteger(fromWeek)) throw new RangeError("fromWeek must be an integer");
  if (!Number.isInteger(horizonWeeks) || horizonWeeks < 0) throw new RangeError("horizonWeeks must be a non-negative integer");
  const out: { weekIndex: number; tier: number }[] = [];
  for (let w = fromWeek; w < fromWeek + horizonWeeks; w++) {
    const tiers = cosmeticRotationForWeek(w);
    for (let t = 0; t < tiers.length; t++) {
      if (tiers[t]!.includes(cosmeticId)) out.push({ weekIndex: w, tier: t + 1 });
    }
  }
  return out;
}

/** Catalog invariants. Called once at content load (index.ts). */
export function assertCosmeticsValid(): void {
  const fail = (why: string): never => {
    throw new Error(`cosmetics: ${why}`);
  };
  const unitIds = new Set<string>(LIVING_UNIT_TYPES.map((u) => u.id));
  const seen = new Set<string>();
  for (let i = 0; i < COSMETIC_TYPES.length; i++) {
    const c = COSMETIC_TYPES[i]!;
    if (seen.has(c.id)) fail(`duplicate id ${c.id}`);
    seen.add(c.id);
    if (i > 0 && !(COSMETIC_TYPES[i - 1]!.id < c.id)) fail("catalog is not sorted by id");
    if (!isCosmeticKind(c.kind)) fail(`${c.id}: unknown kind ${String(c.kind)}`);
    if (!c.reviewNote) fail(`${c.id}: missing the scouting-readability review note`);
    if (c.kind === "unit_skin") {
      if (c.appliesTo === null || !unitIds.has(c.appliesTo)) fail(`${c.id}: unit skin for unknown unit type ${String(c.appliesTo)}`);
    } else if (c.appliesTo !== null) fail(`${c.id}: only unit skins apply to a type`);
    // Nothing numeric may live on a cosmetic: the structural guarantee that one cannot be a stat.
    for (const [k, v] of Object.entries(c)) if (typeof v === "number") fail(`${c.id}: numeric field '${k}' on a cosmetic`);
  }
  const perWeek = TUNABLES.PACK_COSMETICS_BY_TIER.reduce((a, b) => a + b, 0);
  if (COSMETIC_TYPES.length < perWeek) fail(`catalog holds ${COSMETIC_TYPES.length} cosmetics; a week offers ${perWeek}`);
}
