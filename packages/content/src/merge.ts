import { TUNABLES } from "./tunables.js";

/**
 * Merge math (chunk 16). Pure, fixed-point, integer-only per GUARDRAILS.md #1
 * — no floats anywhere, no transcendental functions. Level defines stats: a
 * unit's stats at a given merge level are a pure function of its base (level
 * 1) stats and TUNABLES.MERGE_STAT_MULT_PER_LEVEL_MILLI, identical regardless
 * of which recipe (2→1 or 5→3) it took to get there. This is load-bearing —
 * it's what keeps "no branching, no specialization at merge time" true.
 */

export interface StatBlock {
  readonly offense: number;
  readonly defense: number;
  readonly hp: number;
}

export type MergeRecipeKind = "small" | "large";

function scaleOnce(value: number): number {
  return Math.trunc((value * TUNABLES.MERGE_STAT_MULT_PER_LEVEL_MILLI) / 1000);
}

/**
 * Level-1 stats are the type's authored base stats, unscaled. Each level
 * above that applies MERGE_STAT_MULT_PER_LEVEL_MILLI cumulatively, truncating
 * to an integer at every step so no fractional drift ever accumulates.
 */
export function statsAtLevel(base: StatBlock, level: number): StatBlock {
  if (!Number.isInteger(level) || level < 1 || level > TUNABLES.MERGE_LEVEL_CAP) {
    throw new RangeError(`merge level ${level} out of range [1, ${TUNABLES.MERGE_LEVEL_CAP}]`);
  }
  let stats: StatBlock = base;
  for (let l = 1; l < level; l++) {
    stats = {
      offense: scaleOnce(stats.offense),
      defense: scaleOnce(stats.defense),
      hp: scaleOnce(stats.hp),
    };
  }
  return stats;
}

export function sumStats(blocks: readonly StatBlock[]): StatBlock {
  return blocks.reduce(
    (acc, b) => ({ offense: acc.offense + b.offense, defense: acc.defense + b.defense, hp: acc.hp + b.hp }),
    { offense: 0, defense: 0, hp: 0 },
  );
}

/** True only if every one of the three stats is strictly less — the
 * no-pay-to-win comparison basis (GUARDRAILS.md #2). */
export function statBlockLessThan(a: StatBlock, b: StatBlock): boolean {
  return a.offense < b.offense && a.defense < b.defense && a.hp < b.hp;
}

export function mergeRecipeSpec(kind: MergeRecipeKind): { readonly consumeCount: number; readonly produceCount: number } {
  return kind === "small" ? TUNABLES.MERGE_RECIPE_SMALL : TUNABLES.MERGE_RECIPE_LARGE;
}

export function mergeCostForTargetLevel(targetLevel: number): number {
  const table = TUNABLES.MERGE_COST_BY_TARGET_LEVEL as Record<number, number>;
  const cost = table[targetLevel];
  if (cost === undefined) {
    throw new RangeError(`no MERGE_COST_BY_TARGET_LEVEL entry for target level ${targetLevel}`);
  }
  return cost;
}
