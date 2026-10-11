/**
 * Fixture candidates for COMPONENT TESTS ONLY (chunk 08). The app itself reads the three
 * scoutable candidates chunk 14 serves; nothing in src/ outside *.test.* imports this.
 *
 * Built the way the server builds a candidate's `scout`: a chunk 09 `Party` run through
 * @caravan/circle's `scoutParty`, so the panel is exercised against the real shape and a
 * field added to ScoutUnit shows up here untouched. Deterministic: encounter N gets
 * `FIXTURE_PARTIES[(N − 1) % 3]`.
 */
import { ENTRY_BAND_DEPTH, GRID_HEIGHT, GRID_WIDTH, scoutParty, type Cell, type EntryEdge, type Party, type PartyScoutView, type TargetingStance } from "@caravan/circle";
import type { CandidateView } from "../../api/types.ts";
import type { ScoutedEncounter } from "./scoutTypes.ts";

interface UnitSpec {
  readonly typeId: string;
  readonly mergeLevel: number;
  readonly stance: TargetingStance;
  readonly edge: EntryEdge;
  /** Position along the edge, 0..GRID-1; the depth is the outermost row of the band. */
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

function party(units: readonly UnitSpec[], siegeIds: readonly string[]): Party {
  return {
    v: 1,
    units: units.map((u, i) => ({ ref: `a${i}`, typeId: u.typeId, mergeLevel: u.mergeLevel, stance: u.stance, edge: u.edge, cell: entryCell(u.edge, u.along) })),
    siege: siegeIds.map((typeId) => ({ typeId })),
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

export function fixtureScoutFor(encounterIndex: number): PartyScoutView {
  const i = Math.max(0, (encounterIndex - 1) % FIXTURE_PARTIES.length);
  return scoutParty(FIXTURE_PARTIES[i]!);
}

export function fixtureCandidate(encounterIndex: number, candidateId = `${"c".repeat(31)}${encounterIndex % 10}`): CandidateView {
  return {
    candidateId,
    partyId: `party-${encounterIndex}`,
    owner: { accountId: "00000000-0000-4000-8000-000000000000", displayName: `Fixture outfit ${encounterIndex}`, authored: true },
    reputation: { rating: 1000 + encounterIndex * 10, band: { index: 1, low: 1000, high: 1099 }, gapFromCaravan: -encounterIndex * 10, sandbagEarnMultiplier: 1024 },
    scout: fixtureScoutFor(encounterIndex),
  };
}

export function fixtureEncounter(encounterIndex: number): ScoutedEncounter {
  const c = fixtureCandidate(encounterIndex);
  return { encounterIndex, candidateId: c.candidateId, owner: c.owner, reputation: c.reputation, scout: c.scout, source: "fixture" };
}
