/**
 * Coverage (PHASE-2 §26 definition of done): every content type id has an asset entry — an
 * asset folder under assets/art/<class>/<key>/ or an explicit line in assets/art/fallbacks.json
 * (the flat code placeholder). A type with neither, or an entry naming no type, fails the build.
 */
import { COSMETIC_TYPES, FENCE_TIERS, LIVING_UNIT_TYPES, REGION_IDS, SIEGE_TYPES, TRAP_TYPES } from "@caravan/content";

export const ART_CLASSES = ["units", "wagons", "fences", "traps", "siege", "terrain", "town", "ui", "cosmetics"] as const;
export type ArtClass = (typeof ART_CLASSES)[number];

export interface Finding {
  readonly level: "error" | "warning";
  /** "class/key", or "budget/town" etc. */
  readonly id: string;
  readonly message: string;
}

/** The core wagon plus the four parked-wagon views (front/rear of the covered and the supply wagon). */
export const WAGON_KEYS = ["core", "covered_front", "covered_rear", "supply_front", "supply_rear"] as const;

/** `null` marks a free-form class (no content ids exist for it): any key is accepted, none is required. */
export function expectedIds(): Record<ArtClass, readonly string[] | null> {
  return {
    units: LIVING_UNIT_TYPES.map((t) => t.id),
    wagons: WAGON_KEYS,
    fences: FENCE_TIERS.map((t) => t.id),
    traps: TRAP_TYPES.map((t) => t.id),
    siege: SIEGE_TYPES.map((t) => t.id),
    terrain: REGION_IDS,
    town: null,
    ui: null,
    cosmetics: COSMETIC_TYPES.map((t) => t.id),
  };
}

type PerClass<T> = Partial<Record<ArtClass, T>>;

export function checkCoverage(input: {
  expected: PerClass<readonly string[] | null>;
  assets: PerClass<readonly string[]>;
  fallbacks: PerClass<readonly string[]>;
}): Finding[] {
  const out: Finding[] = [];
  const err = (id: string, message: string): number => out.push({ level: "error", id, message });
  const classes = new Set<string>([...Object.keys(input.expected), ...Object.keys(input.assets), ...Object.keys(input.fallbacks)]);
  for (const cls of [...classes].sort()) {
    const c = cls as ArtClass;
    const assets = new Set(input.assets[c] ?? []);
    const fallbacks = new Set(input.fallbacks[c] ?? []);
    if (!(cls in input.expected)) {
      for (const k of [...assets, ...fallbacks]) err(`${cls}/${k}`, `unknown art class '${cls}'`);
      continue;
    }
    const expected = input.expected[c] ?? null;
    if (expected === null) continue;
    const known = new Set(expected);
    for (const k of assets) if (!known.has(k)) err(`${cls}/${k}`, `asset folder names no ${cls} type in packages/content`);
    for (const k of fallbacks) if (!known.has(k)) err(`${cls}/${k}`, `fallbacks.json names no ${cls} type in packages/content`);
    for (const k of expected) {
      const id = `${cls}/${k}`;
      if (assets.has(k) && fallbacks.has(k)) out.push({ level: "warning", id, message: "has an asset and is still listed in fallbacks.json (the asset wins)" });
      else if (!assets.has(k) && !fallbacks.has(k)) err(id, "no asset folder and no fallbacks.json entry");
    }
  }
  return out;
}
