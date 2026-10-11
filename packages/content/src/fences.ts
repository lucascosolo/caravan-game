/**
 * Fence tiers (PROJECT.md §9, chunk 07). Fences are breakable, not walls: every segment
 * has HP and a CATEGORY that a specific siege piece counters (×SIEGE_FENCE_DAMAGE_MULT).
 * Tiers are unlock-web purchases in the trap web (chunk 05). Universal across regions.
 * All values TUNABLE; HP per tier from the chunk 07 brief.
 */
export const FENCE_CATEGORIES = ["timber", "wire", "stone"] as const;
export type FenceCategory = (typeof FENCE_CATEGORIES)[number];

export interface FenceTierType {
  readonly id: `fence.${string}`;
  readonly displayName: string;
  readonly flavor: string;
  /** 1..TUNABLES.FENCE_TIERS. Higher tier = more HP and a later unlock node. */
  readonly tier: number;
  readonly category: FenceCategory;
  /** HP per placed segment. Player-facing; shown in the formation UI. */
  readonly segmentHp: number;
}

export const FENCE_TIERS: readonly FenceTierType[] = [
  {
    id: "fence.brush_pile",
    displayName: "Brush Pile",
    flavor: "Dragged-up sage and deadfall. Slows a horse, not a determined man.",
    tier: 1,
    category: "timber",
    segmentHp: 300,
  },
  {
    id: "fence.split_rail",
    displayName: "Split Rail",
    flavor: "Honest post-and-rail, the kind every homestead starts with.",
    tier: 2,
    category: "timber",
    segmentHp: 400,
  },
  {
    id: "fence.barbed_wire",
    displayName: "Barbed Wire",
    flavor: "Devil's rope. Cheap to string, murder to cross, and it started a few wars.",
    tier: 3,
    category: "wire",
    segmentHp: 650,
  },
  {
    id: "fence.stacked_stone",
    displayName: "Stacked Stone",
    flavor: "Dry-laid field stone, a wagon's width thick. Takes powder to move it.",
    tier: 4,
    category: "stone",
    segmentHp: 1000,
  },
];

export type FenceTierId = (typeof FENCE_TIERS)[number]["id"];

export function isFenceCategory(value: unknown): value is FenceCategory {
  return typeof value === "string" && (FENCE_CATEGORIES as readonly string[]).includes(value);
}
