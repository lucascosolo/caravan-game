/**
 * Fixture standing parties for the scouting panel (chunk 08), used by scoutFeed.ts until
 * chunk 14 serves real matchmade parties. Built from @caravan/content the way chunk 09's
 * snapshot will be (hp = type hp × merge multiplier; offense is the type's offense; the
 * ability is the type's one ability), so the panel is exercised against the real shape.
 *
 * Deterministic: the party for encounter N is `FIXTURES[(N - 1) % 3]`. No randomness —
 * what the player scouts is exactly what they will arrange against.
 */
import { ENTRY_BAND_DEPTH, GRID_HEIGHT, GRID_WIDTH, type Cell, type EntryEdge } from "@caravan/circle";
import { getSiegeType, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
import { PARTY_VERSION, type Party, type PartyUnit } from "@caravan/resolver";

interface UnitSpec {
  readonly typeId: string;
  readonly mergeLevel: number;
  readonly stance: PartyUnit["stance"];
  readonly edge: EntryEdge;
  /** Position along the edge, 0..GRID-1; the depth into the band is fixed at the outermost row. */
  readonly along: number;
}

function entryCell(edge: EntryEdge, along: number): Cell {
  const a = Math.max(0, Math.min(GRID_WIDTH - 1, along));
  const depth = ENTRY_BAND_DEPTH - 1;
  switch (edge) {
    case "north":
      return { x: a, y: depth };
    case "south":
      return { x: a, y: GRID_HEIGHT - 1 - depth };
    case "west":
      return { x: depth, y: a };
    case "east":
      return { x: GRID_WIDTH - 1 - depth, y: a };
  }
}

function unit(ref: string, spec: UnitSpec): PartyUnit {
  const t = getUnitType(spec.typeId);
  if (!t) throw new Error(`scout fixture names unknown unit type '${spec.typeId}'`);
  const maxHp = scaleInt(t.hp, mergeStatMult(spec.mergeLevel));
  return {
    ref,
    typeId: spec.typeId,
    mergeLevel: spec.mergeLevel,
    stance: spec.stance,
    entry: { edge: spec.edge, cell: entryCell(spec.edge, spec.along) },
    hp: maxHp,
    maxHp,
    affinity: t.affinity,
    offense: t.offense,
    moveSpeed: t.moveSpeed,
    attackRange: t.attackRange,
    attackCooldown: t.attackCooldown,
    ability: t.ability,
  };
}

function siege(ref: string, typeId: string): Party["siege"][number] {
  const s = getSiegeType(typeId);
  if (!s) throw new Error(`scout fixture names unknown siege type '${typeId}'`);
  return { ref, typeId, counters: s.counters };
}

function party(units: readonly UnitSpec[], siegeIds: readonly string[]): Party {
  return {
    v: PARTY_VERSION,
    units: units.map((u, i) => unit(`a${i}`, u)),
    siege: siegeIds.map((id, i) => siege(`s${i}`, id)),
  };
}

/** Three parties of rising difficulty: a two-edge raid, a siege-heavy push, a four-edge split. */
export const FIXTURE_PARTIES: readonly Party[] = [
  party(
    [
      { typeId: "desert.dust_rider", mergeLevel: 1, stance: "nearest", edge: "north", along: 12 },
      { typeId: "desert.dust_rider", mergeLevel: 2, stance: "core", edge: "north", along: 18 },
      { typeId: "high_plains.homesteader", mergeLevel: 1, stance: "traps", edge: "east", along: 15 },
    ],
    ["siege.battering_wagon"],
  ),
  party(
    [
      { typeId: "desert.well_digger", mergeLevel: 2, stance: "core", edge: "west", along: 14 },
      { typeId: "desert.well_digger", mergeLevel: 1, stance: "core", edge: "west", along: 18 },
      { typeId: "desert.sand_sharpshooter", mergeLevel: 1, stance: "nearest", edge: "west", along: 10 },
      { typeId: "mountain.grizzly", mergeLevel: 1, stance: "nearest", edge: "south", along: 16 },
      { typeId: "desert.canteen_carrier", mergeLevel: 1, stance: "nearest", edge: "west", along: 16 },
    ],
    ["siege.battering_wagon", "siege.bridging_planks"],
  ),
  party(
    [
      { typeId: "badlands.gunslinger", mergeLevel: 2, stance: "nearest", edge: "north", along: 15 },
      { typeId: "badlands.bounty_hunter", mergeLevel: 1, stance: "traps", edge: "east", along: 15 },
      { typeId: "mountain.trapper", mergeLevel: 1, stance: "traps", edge: "south", along: 15 },
      { typeId: "high_plains.prairie_wolf", mergeLevel: 3, stance: "core", edge: "west", along: 15 },
      { typeId: "desert.coyote_pack", mergeLevel: 1, stance: "nearest", edge: "north", along: 8 },
      { typeId: "desert.longhorn_bull", mergeLevel: 1, stance: "core", edge: "south", along: 22 },
    ],
    ["siege.fence_cutters", "siege.dousing_wagon", "siege.battering_wagon"],
  ),
];

export function fixturePartyFor(encounterIndex: number): Party {
  const i = Math.max(0, (encounterIndex - 1) % FIXTURE_PARTIES.length);
  return FIXTURE_PARTIES[i]!;
}
