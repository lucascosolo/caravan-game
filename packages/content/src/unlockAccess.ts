/**
 * Stand-in for chunk 05's full unlock web. That chunk defines `hasAccess` as
 * "the single source of truth every other system calls" (GUARDRAILS.md #3);
 * this file gives chunk 09 that same single-predicate shape now so the
 * standing party builder is already wired to the real gate's contract and
 * doesn't need to change when chunk 05 lands — only this function's body does.
 */
export interface UnlockedAccess {
  readonly livingUnitTypeIds: ReadonlySet<string>;
  readonly siegeTypeIds: ReadonlySet<string>;
  readonly trapTypeIds: ReadonlySet<string>;
}

export function hasAccess(
  access: UnlockedAccess,
  kind: "living_unit" | "siege" | "trap",
  typeId: string,
): boolean {
  switch (kind) {
    case "living_unit":
      return access.livingUnitTypeIds.has(typeId);
    case "siege":
      return access.siegeTypeIds.has(typeId);
    case "trap":
      return access.trapTypeIds.has(typeId);
  }
}
