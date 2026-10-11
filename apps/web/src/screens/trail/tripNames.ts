/**
 * Display names for the refs the trip routes return (content lookups only: a type's name is
 * content, not a game fact). A fence segment is named by its tier and its number in the pack
 * (`f3` → "Brush Pile #4"), never by its raw ref (chunk 08 QA S15).
 */
import { getFenceTier, getTrapType, getUnitType } from "@caravan/content";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.trip;

export const unitTypeName = (typeId: string): string => getUnitType(typeId)?.displayName ?? STRINGS.trail.unknownThing;
export const trapTypeName = (typeId: string): string => getTrapType(typeId)?.displayName ?? STRINGS.trail.unknownThing;

export function unitLabel(u: { readonly typeId: string; readonly mergeLevel: number }): string {
  return T.unitLevel(unitTypeName(u.typeId), u.mergeLevel);
}

export function fenceLabel(f: { readonly ref: string; readonly tierId: string }): string {
  const name = getFenceTier(f.tierId)?.displayName ?? STRINGS.trail.unknownThing;
  const m = /^f(\d+)$/.exec(f.ref);
  return m ? T.fenceName(name, Number(m[1]) + 1) : name;
}
