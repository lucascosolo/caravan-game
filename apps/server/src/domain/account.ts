import type { RegionId } from "@caravan/content";

/**
 * Slice of chunk 01's schema that chunk 09 needs to reference. Scope split
 * follows GUARDRAILS.md #5: the account is where the standing party and
 * siege/trap access live; the caravan is where region-locked living-unit
 * instances live. Neither table is fully modeled here (that's chunk 01) —
 * only the fields chunk 09's tests touch.
 */
export interface Account {
  readonly id: string;
}

export interface Caravan {
  readonly id: string;
  readonly accountId: string;
  readonly region: RegionId;
}

/**
 * A living-unit instance owned by a caravan (roster). Merge level lives here,
 * per chunk 01. A standing party *references* these by id — it never owns or
 * copies them, which is exactly what keeps the party a template.
 */
export interface UnitInstance {
  readonly id: string;
  readonly caravanId: string;
  readonly typeId: string;
  readonly mergeLevel: number;
}
