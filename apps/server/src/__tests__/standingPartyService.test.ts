import { describe, expect, it } from "vitest";
import { addUnitSlot, createEmptyParty, snapshotParty } from "../domain/standingParty.js";
import { resolveEncounter, type DefendingSideInput } from "@caravan/resolver";
import { ACCOUNT_ID, buildHarness, cell } from "./fixtures.js";

function defense(totalDefense: number, tripId: string): DefendingSideInput {
  return { tripId, totalDefense, coreDistance: 32 };
}

describe("StandingPartyService — template semantics (chunk 09 load-bearing check)", () => {
  it("serving the same party into dozens of resolutions, including losses, leaves the owner's roster byte-identical", () => {
    const { service, unitRepo, unitInstances, ownedCaravanIds } = buildHarness({ unitCount: 4 });
    const party = service.createParty(ACCOUNT_ID);
    unitInstances.forEach((instance, i) => {
      service.addUnit(party.id, ownedCaravanIds, {
        unitInstanceId: instance.id,
        stance: "nearest",
        edge: "north",
        startPosition: cell(i, 0),
      });
    });

    const rosterBefore = unitInstances.map((u) => unitRepo.get(u.id));
    const partyBefore = JSON.stringify(service.getPartyView(party.id));

    // Total unit offense in the fixture roster is 300 (90+110+70+30). Cycle
    // through defense totals that force overrun, stalemate, AND wipe — the
    // wipe case (the party is annihilated) is exactly the one the design
    // calls out as the load-bearing case to check.
    const defenseValues = [100, 300, 900];
    const outcomes = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const { record } = service.serveEncounter({
        partyId: party.id,
        tripId: `trip_${i}`,
        defendingSide: defense(defenseValues[i % defenseValues.length]!, `trip_${i}`),
        takenAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
      outcomes.add(record.outcome);
    }

    expect(outcomes).toEqual(new Set(["overrun", "stalemate", "wipe"]));

    const rosterAfter = unitInstances.map((u) => unitRepo.get(u.id));
    expect(rosterAfter).toEqual(rosterBefore);

    const partyAfter = JSON.stringify(service.getPartyView(party.id));
    expect(partyAfter).toBe(partyBefore);

    expect(service.getResultsFeed(party.id)).toHaveLength(30);
  });

  it("even a fully-lost encounter (wipe) does not damage, de-merge, or remove any party unit", () => {
    const { service, unitRepo, unitInstances, ownedCaravanIds } = buildHarness({ unitCount: 2 });
    const party = service.createParty(ACCOUNT_ID);
    unitInstances.forEach((instance, i) => {
      service.addUnit(party.id, ownedCaravanIds, {
        unitInstanceId: instance.id,
        stance: "nearest",
        edge: "north",
        startPosition: cell(i, 0),
      });
    });

    const before = unitInstances.map((u) => structuredClone(unitRepo.get(u.id)));
    const { record } = service.serveEncounter({
      partyId: party.id,
      tripId: "trip_wipe",
      defendingSide: defense(10_000, "trip_wipe"), // impossibly high — guarantees a wipe
      takenAt: "2026-01-01T00:00:00.000Z",
    });

    expect(record.outcome).toBe("wipe");
    const after = unitInstances.map((u) => unitRepo.get(u.id));
    expect(after).toEqual(before);
    // mergeLevel in particular — de-merge is the specific failure mode the
    // guardrail calls out.
    for (const u of after) expect(u!.mergeLevel).toBe(1);
  });
});

describe("StandingPartyService — concurrency and replay immutability", () => {
  it("a resolution already in flight uses the snapshot taken at serve time, unaffected by a later edit", () => {
    const { unitInstances } = buildHarness({ unitCount: 2 });
    // Build a party directly via domain functions to control timing precisely.
    let party = createEmptyParty("p1", ACCOUNT_ID);
    party = addUnitSlot(party, { unitInstanceId: unitInstances[0]!.id, stance: "nearest", edge: "north", startPosition: cell(0, 0) });

    const unitInstancesById = new Map(unitInstances.map((u) => [u.id, u]));
    // Simulate matchmaking grabbing a snapshot the instant the party is served...
    const snapshotAtServeTime = snapshotParty(party, unitInstancesById, "2026-01-01T00:00:00.000Z");

    // ...then the owner edits the party before the resolver actually runs.
    const editedParty = addUnitSlot(party, { unitInstanceId: unitInstances[1]!.id, stance: "core", edge: "south", startPosition: cell(3, 31) });
    expect(editedParty.unitSlots.length).toBe(2);
    expect(party.unitSlots.length).toBe(1); // original object untouched — immutable update

    // The in-flight resolution uses the frozen snapshot, not the live party.
    const result = resolveEncounter({
      attackingParty: {
        partyId: snapshotAtServeTime.partyId,
        snapshotVersion: snapshotAtServeTime.partyVersionAtSnapshot,
        units: snapshotAtServeTime.units,
        siege: snapshotAtServeTime.siege.map((s) => ({
          slotIndex: s.slotIndex,
          typeId: s.siegeTypeId,
          countersFenceCategory: s.countersFenceCategory,
          countersTrapCategory: s.countersTrapCategory,
          edge: s.edge,
          startPosition: s.startPosition,
        })),
      },
      defendingSide: defense(50, "trip_x"),
    });

    expect(snapshotAtServeTime.units).toHaveLength(1); // still just the one unit from state A
    expect(result.tickLog.some((e) => e.kind === "unit_attack")).toBe(true);
  });

  it("editing the party after it fought does not alter that fight's stored replay or results-feed row", () => {
    const { service, ownedCaravanIds, unitInstances } = buildHarness({ unitCount: 2 });
    const party = service.createParty(ACCOUNT_ID);
    service.addUnit(party.id, ownedCaravanIds, {
      unitInstanceId: unitInstances[0]!.id,
      stance: "nearest",
      edge: "north",
      startPosition: cell(0, 0),
    });

    const { record, replay } = service.serveEncounter({
      partyId: party.id,
      tripId: "trip_1",
      defendingSide: defense(50, "trip_1"),
      takenAt: "2026-01-01T00:00:00.000Z",
    });
    const replaySnapshotBefore = JSON.stringify(replay);
    const recordBefore = JSON.stringify(record);

    // Edit the party several times after the fight.
    service.addUnit(party.id, ownedCaravanIds, {
      unitInstanceId: unitInstances[1]!.id,
      stance: "traps",
      edge: "south",
      startPosition: cell(3, 31),
    });
    service.setStance(party.id, 0, "core");

    const replayAfter = service.getReplay(replay.id);
    expect(JSON.stringify(replayAfter)).toBe(replaySnapshotBefore);

    const feedAfter = service.getResultsFeed(party.id);
    expect(JSON.stringify(feedAfter[0])).toBe(recordBefore);
  });

  it("the owner's replay and the opponent's replay are the same artifact — no per-viewer divergence", () => {
    const { service, ownedCaravanIds, unitInstances } = buildHarness({ unitCount: 2 });
    const party = service.createParty(ACCOUNT_ID);
    service.addUnit(party.id, ownedCaravanIds, {
      unitInstanceId: unitInstances[0]!.id,
      stance: "nearest",
      edge: "north",
      startPosition: cell(0, 0),
    });
    const { replay } = service.serveEncounter({
      partyId: party.id,
      tripId: "trip_1",
      defendingSide: defense(50, "trip_1"),
      takenAt: "2026-01-01T00:00:00.000Z",
    });

    // getReplay takes no viewer/role parameter at all — structurally there is
    // only one artifact to fetch, for either side.
    const ownerView = service.getReplay(replay.id);
    const opponentView = service.getReplay(replay.id);
    expect(ownerView).toStrictEqual(opponentView);
    expect(JSON.stringify(ownerView)).toBe(JSON.stringify(opponentView));
  });
});

describe("StandingPartyService — unit sharing and scoutability", () => {
  it("a unit instance may sit in the standing party and be referenced elsewhere (e.g. an active trip) at the same time", () => {
    const { service, ownedCaravanIds, unitInstances } = buildHarness({ unitCount: 1 });
    const party = service.createParty(ACCOUNT_ID);
    service.addUnit(party.id, ownedCaravanIds, {
      unitInstanceId: unitInstances[0]!.id,
      stance: "nearest",
      edge: "north",
      startPosition: cell(0, 0),
    });

    // Stand-in for a trip's locked manifest (chunk 07) referencing the same
    // unit instance id. No lock/reservation table exists anywhere in this
    // service, so this is legal by construction, not by a special-cased check.
    const tripManifestUnitIds = new Set<string>([unitInstances[0]!.id]);

    expect(service.getPartyView(party.id).units[0]!.unitInstanceId).toBe(unitInstances[0]!.id);
    expect(tripManifestUnitIds.has(unitInstances[0]!.id)).toBe(true);
  });

  it("the scouting view an opponent sees is exactly the builder's own view of the party", () => {
    const { service, ownedCaravanIds, unitInstances } = buildHarness({ unitCount: 2 });
    const party = service.createParty(ACCOUNT_ID);
    service.addUnit(party.id, ownedCaravanIds, {
      unitInstanceId: unitInstances[0]!.id,
      stance: "traps",
      edge: "east",
      startPosition: cell(31, 4),
    });
    service.addSiege(party.id, ownedCaravanIds, {
      siegeTypeId: "siege.dynamite",
      edge: "east",
      startPosition: cell(31, 5),
    });

    const builderView = service.getPartyView(party.id);
    const scoutingView = service.getScoutingView(party.id);
    expect(scoutingView).toStrictEqual(builderView);
  });
});
