import type { LivingUnitType, SiegeType, TrapType } from "./types.js";

/**
 * Seed content — enough distinct, mechanically-different types to exercise the
 * standing party builder and its tests. This is fixture-scale data, not the
 * full chunk 03 roster (8 living units per region, 6 traps, 5 siege pieces);
 * authoring the complete pool is chunk 03's job. Every value here is an
 * authored integer, nothing computed at load time (GUARDRAILS.md #1).
 */
export const LIVING_UNIT_TYPES: readonly LivingUnitType[] = [
  {
    id: "desert.duster",
    region: "desert",
    name: "Duster Raider",
    affinity: "grit",
    offense: 90,
    defense: 40,
    hp: 600,
    moveSpeedMilli: 1800,
    attackRangeMilli: 1000,
    attackCooldownMilli: 900,
    aggroRadiusMilli: 4000,
    leashDistanceMilli: 6000,
    abilityId: "burst_radius",
  },
  {
    id: "desert.sharpshooter",
    region: "desert",
    name: "Sharpshooter",
    affinity: "powder",
    offense: 110,
    defense: 25,
    hp: 400,
    moveSpeedMilli: 1400,
    attackRangeMilli: 4000,
    attackCooldownMilli: 1600,
    aggroRadiusMilli: 5000,
    leashDistanceMilli: 6000,
    abilityId: "heavy_strike",
  },
  {
    id: "mountain.trapper",
    region: "mountain",
    name: "Trapper",
    affinity: "beast",
    offense: 70,
    defense: 60,
    hp: 700,
    moveSpeedMilli: 1500,
    attackRangeMilli: 1000,
    attackCooldownMilli: 1000,
    aggroRadiusMilli: 4000,
    leashDistanceMilli: 6000,
    abilityId: "structure_breaker",
  },
  {
    id: "mountain.healer",
    region: "mountain",
    name: "Camp Medic",
    affinity: "grit",
    offense: 30,
    defense: 55,
    hp: 500,
    moveSpeedMilli: 1500,
    attackRangeMilli: 1000,
    attackCooldownMilli: 1200,
    aggroRadiusMilli: 3000,
    leashDistanceMilli: 5000,
    abilityId: "heal_radius",
  },
] as const;

export const SIEGE_TYPES: readonly SiegeType[] = [
  { id: "siege.battering_ram", name: "Battering Ram", countersFenceCategory: "timber", countersTrapCategory: null },
  { id: "siege.dynamite", name: "Dynamite Charge", countersFenceCategory: "stone", countersTrapCategory: null },
  { id: "siege.wire_cutters", name: "Wire Cutters", countersFenceCategory: "wire", countersTrapCategory: null },
  { id: "siege.pathfinder_scout", name: "Pathfinder Scout", countersFenceCategory: null, countersTrapCategory: "snare" },
  { id: "siege.blast_shield", name: "Blast Shield", countersFenceCategory: null, countersTrapCategory: "blast" },
] as const;

export const TRAP_TYPES: readonly TrapType[] = [
  { id: "trap.snare_wire", name: "Snare Wire", category: "snare", damage: 60 },
  { id: "trap.powder_pit", name: "Powder Pit", category: "blast", damage: 180 },
  { id: "trap.spike_pit", name: "Spike Pit", category: "pit", damage: 120 },
] as const;

export function findLivingUnitType(typeId: string): LivingUnitType | undefined {
  return LIVING_UNIT_TYPES.find((t) => t.id === typeId);
}

export function findSiegeType(typeId: string): SiegeType | undefined {
  return SIEGE_TYPES.find((t) => t.id === typeId);
}

export function findTrapType(typeId: string): TrapType | undefined {
  return TRAP_TYPES.find((t) => t.id === typeId);
}
