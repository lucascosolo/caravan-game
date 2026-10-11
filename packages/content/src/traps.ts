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
 * is TUNABLE; effect magnitudes default to the chunk 11 values in TUNABLES.
 */
import type { AffinityCategory } from "./affinity.js";
import { fpMilli, ms, seconds, type Fixed, type Millis } from "./fixedPoint.js";

export const TRAP_CATEGORIES = ["groundwork", "powder"] as const;
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

export const TRAP_TYPES: readonly TrapType[] = [
  {
    id: "trap.spike_pit",
    displayName: "Spike Pit",
    flavor: "A dug pit, sharpened stakes, a scatter of brush on top. Old as war.",
    category: "groundwork",
    affinity: "grit",
    damage: 250,
    effect: null,
  },
  {
    id: "trap.jaw_trap",
    displayName: "Jaw Trap",
    flavor: "Bear iron, staked to the ground. Whatever steps in it stays a while.",
    category: "groundwork",
    affinity: "grit",
    damage: 160,
    effect: { kind: "root", duration: ms(1500) },
  },
  {
    id: "trap.tripwire_snare",
    displayName: "Tripwire Snare",
    flavor: "Picket rope and a bent sapling. Cheap, quiet, and it holds a leg fast.",
    category: "groundwork",
    affinity: "grit",
    damage: 60,
    effect: { kind: "root", duration: ms(1500) },
  },
  {
    id: "trap.caltrop_scatter",
    displayName: "Caltrop Scatter",
    flavor: "Twisted nails sown across the approach. Nothing walks the same after.",
    category: "groundwork",
    affinity: "grit",
    damage: 90,
    effect: { kind: "slow", magnitude: fpMilli(400), duration: seconds(3) },
  },
  {
    id: "trap.powder_keg",
    displayName: "Powder Keg",
    flavor: "A half-buried keg and a pressure fuse. One step and the ground stands up.",
    category: "powder",
    affinity: "powder",
    damage: 220,
    effect: null,
  },
  {
    id: "trap.tar_pot",
    displayName: "Tar Pot",
    flavor: "Pitch and lamp oil in a tipping pot. Burns slow, sticks to everything.",
    category: "powder",
    affinity: "powder",
    damage: 140,
    effect: { kind: "slow", magnitude: fpMilli(400), duration: seconds(3) },
  },
];

export type TrapTypeId = (typeof TRAP_TYPES)[number]["id"];

export function isTrapCategory(value: unknown): value is TrapCategory {
  return typeof value === "string" && (TRAP_CATEGORIES as readonly string[]).includes(value);
}
