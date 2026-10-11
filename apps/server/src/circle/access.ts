/**
 * The access seam: "is this type unlocked for this player?" — the ONLY gate on which
 * types may be packed or placed (GUARDRAILS §3). Every chunk-07 validation path asks this
 * function; nothing else decides access.
 *
 * TODO(chunk-05): replace the body of `isUnlocked` with chunk 05's `hasAccess(player,
 * typeId)` reading the unlock webs (living web at caravan level and region-scoped;
 * trap/siege/fence-tier webs at account level). Keep the signature: callers pass the
 * owner (account + caravan + region) so the split is available to the real check.
 *
 * Until then it reads a STUB: chunk 05's STARTING_NODES default — 2 living units (the
 * first two of the caravan's region roster), 1 trap, 1 siege piece — unlocked free at
 * creation so a new account can actually play. The brief lists no starting fence tier;
 * tier 1 is included here as an ASSUMPTION (a caravan with no fence has no circle) and
 * is flagged for chunk 05 to confirm.
 */
import { LIVING_UNIT_TYPES, type RegionId } from "@caravan/content";
import type { AccessCheck } from "@caravan/circle";

export interface AccessOwner {
  readonly accountId: string;
  readonly caravanId: string;
  readonly regionId: RegionId;
}

/** TODO(chunk-05): stub of the STARTING_NODES tunable; chunk 05 owns the real value. */
export const STARTING_NODES = {
  /** Per region: the first two living-unit types of that region's roster. */
  livingPerRegion: 2,
  trap: ["trap.spike_pit"] as readonly string[],
  siege: ["siege.battering_wagon"] as readonly string[],
  /** ASSUMPTION — see header. */
  fence: ["fence.brush_pile"] as readonly string[],
} as const;

function startingLivingTypes(regionId: RegionId): readonly string[] {
  return LIVING_UNIT_TYPES.filter((u) => u.regionId === regionId)
    .slice(0, STARTING_NODES.livingPerRegion)
    .map((u) => u.id);
}

/** The unlocked set for an owner. Living types are region-scoped; nothing else is. */
export function unlockedTypeIds(owner: AccessOwner): ReadonlySet<string> {
  // TODO(chunk-05): read the owner's reached nodes from pool_progress / the unlock webs.
  return new Set<string>([...startingLivingTypes(owner.regionId), ...STARTING_NODES.trap, ...STARTING_NODES.siege, ...STARTING_NODES.fence]);
}

export function isUnlocked(owner: AccessOwner, typeId: string): boolean {
  return unlockedTypeIds(owner).has(typeId);
}

/** Bind an owner once; the circle package takes the resulting predicate. */
export function accessCheckFor(owner: AccessOwner): AccessCheck {
  const set = unlockedTypeIds(owner);
  return (typeId) => set.has(typeId);
}
