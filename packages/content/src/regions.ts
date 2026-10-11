/**
 * Regions: 3–4 biome-based regions, chosen once per caravan and never swapped.
 * Region affects ONLY which living units are available (PROJECT.md §4). There is no
 * map, no travel, no geography attached to it anywhere.
 *
 * Names are placeholders (chunk 01 default). Chunk 03 attaches living-unit rosters.
 * The `region` table in the database is seeded from this same list; a test asserts
 * the two stay in sync.
 */
import { deepFreeze } from "./freeze.js";

export const REGIONS = deepFreeze([
  { id: "desert", displayName: "Desert" },
  { id: "high_plains", displayName: "High Plains" },
  { id: "mountain", displayName: "Mountain" },
  { id: "badlands", displayName: "Badlands" },
] as const);

export type RegionId = (typeof REGIONS)[number]["id"];

export const REGION_IDS: readonly RegionId[] = deepFreeze(REGIONS.map((r) => r.id));

export function isRegionId(value: unknown): value is RegionId {
  return typeof value === "string" && (REGION_IDS as readonly string[]).includes(value);
}
