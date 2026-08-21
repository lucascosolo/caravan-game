import { describe, expect, it } from "vitest";
import { TUNABLES, STANCES } from "@caravan/content";
import {
  addSiegeSlot,
  addUnitSlot,
  canonicalSnapshotBytes,
  createEmptyParty,
  PartyValidationError,
  removeUnitSlot,
  snapshotParty,
  validateParty,
} from "../domain/standingParty.js";
import { ACCOUNT_ID, buildHarness, cell } from "./fixtures.js";

describe("standing party builder — slot caps, stances, approach edges", () => {
  it("enforces PARTY_SLOT_CAP (8 living units) server-side", () => {
    const { unitInstances, ownedCaravanIds, accessRepo } = buildHarness({ unitCount: TUNABLES.PARTY_SLOT_CAP + 1 });
    let party = createEmptyParty("p1", ACCOUNT_ID);
    for (const instance of unitInstances) {
      party = addUnitSlot(party, {
        unitInstanceId: instance.id,
        stance: "nearest",
        edge: "north",
        startPosition: cell(5, 0),
      });
    }

    expect(party.unitSlots.length).toBe(TUNABLES.PARTY_SLOT_CAP + 1);
    const unitInstancesById = new Map(unitInstances.map((u) => [u.id, u]));
    expect(() =>
      validateParty(party, { unitInstancesById, ownedCaravanIds, access: accessRepo.getForAccount(ACCOUNT_ID) }),
    ).toThrow(PartyValidationError);
  });

  it("enforces SIEGE_SLOT_CAP (3) server-side, independent of the unit cap", () => {
    const { unitInstances, ownedCaravanIds, accessRepo } = buildHarness();
    const unitInstancesById = new Map(unitInstances.map((u) => [u.id, u]));
    let party = createEmptyParty("p1", ACCOUNT_ID);
    const siegeIds = ["siege.battering_ram", "siege.dynamite", "siege.wire_cutters", "siege.pathfinder_scout"];
    for (const siegeTypeId of siegeIds) {
      party = addSiegeSlot(party, { siegeTypeId, edge: "east", startPosition: cell(31, 5) });
    }
    expect(party.siegeSlots.length).toBe(4);
    expect(() =>
      validateParty(party, { unitInstancesById, ownedCaravanIds, access: accessRepo.getForAccount(ACCOUNT_ID) }),
    ).toThrow(/SIEGE_SLOT_CAP/);
  });

  it("accepts exactly the three fixed stances and rejects anything else", () => {
    expect(STANCES).toEqual(["nearest", "traps", "core"]);
    const { unitInstances, ownedCaravanIds, accessRepo } = buildHarness();
    const unitInstancesById = new Map(unitInstances.map((u) => [u.id, u]));
    let party = createEmptyParty("p1", ACCOUNT_ID);
    for (const stance of STANCES) {
      party = addUnitSlot(party, {
        unitInstanceId: unitInstances[0]!.id,
        stance,
        edge: "north",
        startPosition: cell(0, 0),
      });
    }
    expect(() =>
      validateParty(party, { unitInstancesById, ownedCaravanIds, access: accessRepo.getForAccount(ACCOUNT_ID) }),
    ).not.toThrow();

    const badParty = addUnitSlot(createEmptyParty("p2", ACCOUNT_ID), {
      unitInstanceId: unitInstances[0]!.id,
      // @ts-expect-error deliberately invalid stance for the test
      stance: "berserk",
      edge: "north",
      startPosition: cell(0, 0),
    });
    expect(() =>
      validateParty(badParty, { unitInstancesById, ownedCaravanIds, access: accessRepo.getForAccount(ACCOUNT_ID) }),
    ).toThrow(/stance/);
  });

  it("allows a party to split across multiple approach edges, up to all four", () => {
    const { unitInstances, ownedCaravanIds, accessRepo } = buildHarness({ unitCount: 4 });
    const unitInstancesById = new Map(unitInstances.map((u) => [u.id, u]));
    let party = createEmptyParty("p1", ACCOUNT_ID);
    const edgesWithBandPositions = [
      { edge: "north" as const, pos: cell(3, 0) },
      { edge: "south" as const, pos: cell(3, 31) },
      { edge: "east" as const, pos: cell(31, 3) },
      { edge: "west" as const, pos: cell(0, 3) },
    ];
    edgesWithBandPositions.forEach(({ edge, pos }, i) => {
      party = addUnitSlot(party, { unitInstanceId: unitInstances[i]!.id, stance: "nearest", edge, startPosition: pos });
    });

    expect(new Set(party.unitSlots.map((s) => s.edge)).size).toBe(4);
    expect(() =>
      validateParty(party, { unitInstancesById, ownedCaravanIds, access: accessRepo.getForAccount(ACCOUNT_ID) }),
    ).not.toThrow();
  });

  it("rejects a starting position outside the outermost START_POSITION_BAND cells of its edge", () => {
    const { unitInstances, ownedCaravanIds, accessRepo } = buildHarness();
    const unitInstancesById = new Map(unitInstances.map((u) => [u.id, u]));
    // North band is y < START_POSITION_BAND (2); y=10 is deep in the interior.
    const party = addUnitSlot(createEmptyParty("p1", ACCOUNT_ID), {
      unitInstanceId: unitInstances[0]!.id,
      stance: "nearest",
      edge: "north",
      startPosition: cell(3, 10),
    });
    expect(() =>
      validateParty(party, { unitInstancesById, ownedCaravanIds, access: accessRepo.getForAccount(ACCOUNT_ID) }),
    ).toThrow(/START_POSITION_BAND/);
  });

  it("rejects a unit instance the account does not own", () => {
    const { unitInstances, accessRepo } = buildHarness();
    const unitInstancesById = new Map(unitInstances.map((u) => [u.id, u]));
    const party = addUnitSlot(createEmptyParty("p1", ACCOUNT_ID), {
      unitInstanceId: unitInstances[0]!.id,
      stance: "nearest",
      edge: "north",
      startPosition: cell(0, 0),
    });
    expect(() =>
      validateParty(party, {
        unitInstancesById,
        ownedCaravanIds: new Set(["some_other_caravan"]),
        access: accessRepo.getForAccount(ACCOUNT_ID),
      }),
    ).toThrow(/not owned/);
  });

  it("rejects a type the account has not unlocked — server-side, not just UI filtering", () => {
    const { unitInstances, ownedCaravanIds } = buildHarness({
      access: { livingUnitTypeIds: new Set(), siegeTypeIds: new Set(), trapTypeIds: new Set() },
    });
    const unitInstancesById = new Map(unitInstances.map((u) => [u.id, u]));
    const party = addUnitSlot(createEmptyParty("p1", ACCOUNT_ID), {
      unitInstanceId: unitInstances[0]!.id,
      stance: "nearest",
      edge: "north",
      startPosition: cell(0, 0),
    });
    expect(() =>
      validateParty(party, { unitInstancesById, ownedCaravanIds, access: { livingUnitTypeIds: new Set(), siegeTypeIds: new Set(), trapTypeIds: new Set() } }),
    ).toThrow(/not unlocked/);
  });

  it("removing a slot drops it cleanly and leaves stable slotIndex ordering on the rest", () => {
    const { unitInstances } = buildHarness({ unitCount: 3 });
    let party = createEmptyParty("p1", ACCOUNT_ID);
    for (const instance of unitInstances) {
      party = addUnitSlot(party, { unitInstanceId: instance.id, stance: "nearest", edge: "north", startPosition: cell(0, 0) });
    }
    const afterRemove = removeUnitSlot(party, 1);
    expect(afterRemove.unitSlots.map((s) => s.slotIndex)).toEqual([0, 2]);
  });
});

describe("party snapshot — deterministic serialization", () => {
  it("byte-compares identically across repeated snapshots of the same party state", () => {
    const { unitInstances } = buildHarness({ unitCount: 2 });
    const unitInstancesById = new Map(unitInstances.map((u) => [u.id, u]));
    let party = createEmptyParty("p1", ACCOUNT_ID);
    for (const instance of unitInstances) {
      party = addUnitSlot(party, { unitInstanceId: instance.id, stance: "core", edge: "south", startPosition: cell(3, 31) });
    }
    party = addSiegeSlot(party, { siegeTypeId: "siege.dynamite", edge: "west", startPosition: cell(0, 1) });

    const snapshots = Array.from({ length: 50 }, () => snapshotParty(party, unitInstancesById, "2026-01-01T00:00:00.000Z"));
    const bytes = snapshots.map(canonicalSnapshotBytes);
    expect(new Set(bytes).size).toBe(1);
  });

  it("orders units and siege by explicit slotIndex regardless of Map iteration order", () => {
    const { unitInstances } = buildHarness({ unitCount: 3 });
    // Build the id->instance map in reverse order to prove ordering doesn't leak from iteration.
    const reversed = new Map([...unitInstances].reverse().map((u) => [u.id, u]));
    let party = createEmptyParty("p1", ACCOUNT_ID);
    for (const instance of unitInstances) {
      party = addUnitSlot(party, { unitInstanceId: instance.id, stance: "nearest", edge: "north", startPosition: cell(0, 0) });
    }
    const snap = snapshotParty(party, reversed, "2026-01-01T00:00:00.000Z");
    expect(snap.units.map((u) => u.slotIndex)).toEqual([0, 1, 2]);
  });
});
