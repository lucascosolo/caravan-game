/**
 * @caravan/content — authored game data and the tunables registry. Pure data: no I/O, no
 * clock, no randomness, no floats (see fixedPoint.ts). Validated once at import.
 */
export * from "./fixedPoint.js";
export * from "./freeze.js";
export * from "./tunables.js";
export * from "./regions.js";
export * from "./affinity.js";
export * from "./abilities.js";
export * from "./units.js";
export * from "./traps.js";
export * from "./siege.js";
export * from "./fences.js";
export * from "./validate.js";

import { FENCE_TIERS, type FenceTierType } from "./fences.js";
import { deepFreeze } from "./freeze.js";
import { SIEGE_TYPES, type SiegeType } from "./siege.js";
import { TRAP_TYPES, type TrapType } from "./traps.js";
import { LIVING_UNIT_TYPES, type LivingUnitType } from "./units.js";
import { assertContentValid, type ContentBundle } from "./validate.js";

/** Everything, in one diffable bundle. Deep-frozen, like every export (chunk 03 QA S2). */
export const CONTENT: ContentBundle = deepFreeze({
  units: LIVING_UNIT_TYPES,
  traps: TRAP_TYPES,
  siege: SIEGE_TYPES,
  fences: FENCE_TIERS,
});

assertContentValid(CONTENT);

function byId<T extends { readonly id: string }>(list: readonly T[]): ReadonlyMap<string, T> {
  return new Map(list.map((x) => [x.id, x]));
}

const UNITS_BY_ID = byId(LIVING_UNIT_TYPES);
const TRAPS_BY_ID = byId(TRAP_TYPES);
const SIEGE_BY_ID = byId(SIEGE_TYPES);
const FENCES_BY_ID = byId(FENCE_TIERS);

export function getUnitType(id: string): LivingUnitType | undefined {
  return UNITS_BY_ID.get(id);
}
export function getTrapType(id: string): TrapType | undefined {
  return TRAPS_BY_ID.get(id);
}
export function getSiegeType(id: string): SiegeType | undefined {
  return SIEGE_BY_ID.get(id);
}
export function getFenceTier(id: string): FenceTierType | undefined {
  return FENCES_BY_ID.get(id);
}
export function isUnitTypeId(id: unknown): id is LivingUnitType["id"] {
  return typeof id === "string" && UNITS_BY_ID.has(id);
}
export function isTrapTypeId(id: unknown): id is TrapType["id"] {
  return typeof id === "string" && TRAPS_BY_ID.has(id);
}
export function isSiegeTypeId(id: unknown): id is SiegeType["id"] {
  return typeof id === "string" && SIEGE_BY_ID.has(id);
}
export function isFenceTierId(id: unknown): id is FenceTierType["id"] {
  return typeof id === "string" && FENCES_BY_ID.has(id);
}
