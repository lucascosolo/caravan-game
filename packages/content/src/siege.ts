/**
 * Siege equipment (PROJECT.md §3, §10; chunk 03). Offense-only, universal across regions,
 * carried by a standing raid party — the PASSIVE side. A party's owner picks siege blind
 * to any particular caravan, so each piece is a standing bet on what kind of wagon circle
 * the party will meet.
 *
 * Siege is a COUNTER, never a general buff: each piece counters exactly one fence category
 * (×TUNABLES.SIEGE_FENCE_DAMAGE_MULT to those segments — "accelerates") or exactly one trap
 * category (full nullify — "bypasses"; the trap is still spent). The relationships are the
 * data below, not code branches. Siege has no stats, no abilities, and never fights units.
 */
import type { FenceCategory } from "./fences.js";
import { deepFreeze } from "./freeze.js";
import type { TrapCategory } from "./traps.js";

/** What a siege piece counters. Exactly one target per piece, so the bet is legible. */
export type SiegeCounter =
  | { readonly kind: "fence"; readonly category: FenceCategory }
  | { readonly kind: "trap"; readonly category: TrapCategory };

export interface SiegeType {
  readonly id: `siege.${string}`;
  readonly displayName: string;
  readonly flavor: string;
  readonly counters: SiegeCounter;
}

export const SIEGE_TYPES: readonly SiegeType[] = deepFreeze([
  {
    id: "siege.battering_wagon",
    displayName: "Battering Wagon",
    flavor: "A freight wagon with an iron-shod beam and no brakes. Rails don't argue.",
    counters: { kind: "fence", category: "timber" },
  },
  {
    id: "siege.fence_cutters",
    displayName: "Fence Cutters",
    flavor: "Long-handled nippers and men who've done this before, at night, for money.",
    counters: { kind: "fence", category: "wire" },
  },
  {
    id: "siege.blasting_crate",
    displayName: "Blasting Crate",
    flavor: "Mine-grade powder with a short fuse. Stone fences become stone piles.",
    counters: { kind: "fence", category: "stone" },
  },
  {
    id: "siege.bridging_planks",
    displayName: "Bridging Planks",
    flavor: "Sounding poles and wagon boards. Pits get found, wires get stepped over.",
    counters: { kind: "trap", category: "groundwork" },
  },
  {
    id: "siege.dousing_wagon",
    displayName: "Dousing Wagon",
    flavor: "A water tank on wheels, driven ahead. Wet fuses don't burn and wet pitch won't light.",
    counters: { kind: "trap", category: "powder" },
  },
]);

export type SiegeTypeId = (typeof SIEGE_TYPES)[number]["id"];
