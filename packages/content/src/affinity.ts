/**
 * The type/affinity layer (PROJECT.md §11, chunk 03). Exists specifically so that summing
 * one stat is not the whole story: a stat-inferior party with a favourable matchup must be
 * able to beat a stat-superior one (chunk 11 tests that against the resolver).
 *
 * Three categories tied to regional unit flavour and trap classes:
 *   Grit   — people: settlers, outlaws, workers. Endure and close distance.
 *   Powder — firearms, blasting, frontier industry. Reach and burst.
 *   Beast  — animals and the mounted. Speed and mass.
 *
 * The matrix is a strict rock-paper-scissors cycle so there is no dominant category:
 *   Powder beats Beast (guns stop a charge), Beast beats Grit (mass overruns people),
 *   Grit beats Powder (closing in under fire). Everything else is neutral.
 *
 * The multipliers live in TUNABLES (AFFINITY_ADVANTAGE_MULT / AFFINITY_DISADVANTAGE_MULT).
 * This file holds only the RELATIONSHIPS — categorical, legible, authored data.
 */
export const AFFINITY_CATEGORIES = ["grit", "powder", "beast"] as const;
export type AffinityCategory = (typeof AFFINITY_CATEGORIES)[number];

export type AffinityOutcome = "advantage" | "neutral" | "disadvantage";

/**
 * AFFINITY_MATRIX[dealer][receiver]: the outcome for whoever is DEALING damage of category
 * `dealer` to a target of category `receiver`. Complete: every ordered pair is present.
 * Traps deal damage of their own affinity category and use the same matrix.
 */
export const AFFINITY_MATRIX: Readonly<
  Record<AffinityCategory, Readonly<Record<AffinityCategory, AffinityOutcome>>>
> = {
  grit: { grit: "neutral", powder: "advantage", beast: "disadvantage" },
  powder: { grit: "disadvantage", powder: "neutral", beast: "advantage" },
  beast: { grit: "advantage", powder: "disadvantage", beast: "neutral" },
};

export function affinityOutcome(dealer: AffinityCategory, receiver: AffinityCategory): AffinityOutcome {
  return AFFINITY_MATRIX[dealer][receiver];
}

export function isAffinityCategory(value: unknown): value is AffinityCategory {
  return typeof value === "string" && (AFFINITY_CATEGORIES as readonly string[]).includes(value);
}
