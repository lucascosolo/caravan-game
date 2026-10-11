/**
 * Traps (PROJECT.md §3, §9; chunk 03). Defense-only, universal across regions, carried by
 * the caravan — the ACTIVE side. Single-trigger: fire once on contact, then spent for the
 * rest of the trip (no re-arm between encounters).
 *
 * Two orthogonal classifications:
 *  - `category` — the trap CLASS a siege piece counters (nullifies). Groundwork is dug or
 *    laid in the ground; powder is explosive or incendiary.
 *  - `affinity` — the damage category the trap deals, run through AFFINITY_MATRIX against
 *    the unit it hits. Groundwork traps deal Grit damage, powder traps deal Powder damage;
 *    this ties trap classes into the affinity layer as PROJECT.md §11 asks.
 *
 * Damage is flat (TRAP_DAMAGE_MIN..MAX) and may carry one deterministic effect. Every value
 * is TUNABLE. Effect magnitudes REFERENCE the chunk 11 defaults in TUNABLES (the keys in
 * TUNABLES.PER_TYPE_OVERRIDABLE_DEFAULTS) rather than re-authoring them, so re-tuning the
 * default re-tunes every trap that did not deliberately deviate; a trap that wants its own
 * value authors a literal instead (none does yet).
 */
import type { AffinityCategory } from "./affinity.js";
import type { Fixed, Millis } from "./fixedPoint.js";
import { deepFreeze } from "./freeze.js";
import { TUNABLES } from "./tunables.js";

export const TRAP_CATEGORIES = deepFreeze(["groundwork", "powder"] as const);
export type TrapCategory = (typeof TRAP_CATEGORIES)[number];

/** Deterministic status effect applied to the unit that triggers the trap. */
export type TrapEffect =
  | { readonly kind: "slow"; readonly magnitude: Fixed; readonly duration: Millis }
  | { readonly kind: "root"; readonly duration: Millis };

export interface TrapType {
  readonly id: `trap.${string}`;
  readonly displayName: string;
  readonly flavor: string;
  readonly category: TrapCategory;
  readonly affinity: AffinityCategory;
  /** Flat damage on trigger, before affinity. Player-facing. */
  readonly damage: number;
  /** Optional single effect; `null` for pure damage. */
  readonly effect: TrapEffect | null;
}

export const TRAP_TYPES: readonly TrapType[] = deepFreeze([
  {
    id: "trap.spike_pit",
    displayName: "Spike Pit",
    flavor: "A dug pit, sharpened stakes, a scatter of brush on top. Old as war.",
    category: "groundwork",
    affinity: "grit",
    damage: 375,
    effect: null,
  },
  {
    id: "trap.jaw_trap",
    displayName: "Jaw Trap",
    flavor: "Bear iron, staked to the ground. Whatever steps in it stays a while.",
    category: "groundwork",
    affinity: "grit",
    damage: 240,
    effect: { kind: "root", duration: TUNABLES.TRAP_ROOT_DURATION_DEFAULT },
  },
  {
    id: "trap.tripwire_snare",
    displayName: "Tripwire Snare",
    flavor: "Picket rope and a bent sapling. Cheap, quiet, and it holds a leg fast.",
    category: "groundwork",
    affinity: "grit",
    damage: 90,
    effect: { kind: "root", duration: TUNABLES.TRAP_ROOT_DURATION_DEFAULT },
  },
  {
    id: "trap.caltrop_scatter",
    displayName: "Caltrop Scatter",
    flavor: "Twisted nails sown across the approach. Nothing walks the same after.",
    category: "groundwork",
    affinity: "grit",
    damage: 135,
    effect: { kind: "slow", magnitude: TUNABLES.TRAP_SLOW_MAGNITUDE_DEFAULT, duration: TUNABLES.TRAP_SLOW_DURATION_DEFAULT },
  },
  {
    id: "trap.powder_keg",
    displayName: "Powder Keg",
    flavor: "A half-buried keg and a pressure fuse. One step and the ground stands up.",
    category: "powder",
    affinity: "powder",
    damage: 330,
    effect: null,
  },
  {
    id: "trap.tar_pot",
    displayName: "Tar Pot",
    flavor: "Pitch and lamp oil in a tipping pot. Burns slow, sticks to everything.",
    category: "powder",
    affinity: "powder",
    damage: 210,
    effect: { kind: "slow", magnitude: TUNABLES.TRAP_SLOW_MAGNITUDE_DEFAULT, duration: TUNABLES.TRAP_SLOW_DURATION_DEFAULT },
  },
]);

export type TrapTypeId = (typeof TRAP_TYPES)[number]["id"];

export function isTrapCategory(value: unknown): value is TrapCategory {
  return typeof value === "string" && (TRAP_CATEGORIES as readonly string[]).includes(value);
}
