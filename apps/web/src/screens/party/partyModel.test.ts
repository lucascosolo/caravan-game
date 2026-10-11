import { ENTRY_BAND_DEPTH, GRID_HEIGHT, GRID_WIDTH, PARTY_CONFIG_VERSION, isEntryCell, type PartyConfig } from "@caravan/circle";
import { describe, expect, it } from "vitest";
import { addUnit, canDropAt, configKey, countsByEdge, edgeForDrop, edgesContaining, moveTo, removeUnit, setEdge, setStance, toggleSiege } from "./partyModel.ts";

const EMPTY: PartyConfig = { v: PARTY_CONFIG_VERSION, units: [], siege: [] };

describe("party builder model", () => {
  it("adds a unit once, on the north band with the default stance, inside the band", () => {
    const c = addUnit(addUnit(EMPTY, "a"), "a");
    expect(c.units).toHaveLength(1);
    expect(c.units[0]).toMatchObject({ ref: "a", stance: "nearest", edge: "north" });
    expect(isEntryCell(c.units[0]!.cell, "north")).toBe(true);
    expect(removeUnit(c, "a").units).toHaveLength(0);
  });

  it("drops only onto an entry band; the edge follows the band, keeping the current edge at a corner", () => {
    let c = addUnit(EMPTY, "a");
    expect(canDropAt({ x: 16, y: 16 })).toBe(false);
    expect(moveTo(c, "a", { x: 16, y: 16 })).toBe(c);
    c = moveTo(c, "a", { x: GRID_WIDTH - 1, y: 10 });
    expect(c.units[0]).toMatchObject({ edge: "east", cell: { x: GRID_WIDTH - 1, y: 10 } });
    expect(edgesContaining({ x: 0, y: 0 })).toEqual(expect.arrayContaining(["north", "west"]));
    expect(edgeForDrop({ x: 0, y: 0 }, "west")).toBe("west");
    expect(edgeForDrop({ x: 10, y: GRID_HEIGHT - ENTRY_BAND_DEPTH }, "north")).toBe("south");
  });

  it("an edge change from the list re-snaps the cell into that band", () => {
    let c = moveTo(addUnit(EMPTY, "a"), "a", { x: 12, y: 1 });
    c = setEdge(c, "a", "south");
    expect(c.units[0]!.edge).toBe("south");
    expect(isEntryCell(c.units[0]!.cell, "south")).toBe(true);
    c = setEdge(c, "a", "west");
    expect(isEntryCell(c.units[0]!.cell, "west")).toBe(true);
  });

  it("stance, siege toggles, counts by edge and a stable dirty key", () => {
    let c = setStance(addUnit(addUnit(EMPTY, "b"), "a"), "a", "core");
    expect(c.units.find((u) => u.ref === "a")!.stance).toBe("core");
    c = toggleSiege(c, "siege.battering_wagon");
    expect(c.siege).toEqual(["siege.battering_wagon"]);
    expect(toggleSiege(c, "siege.battering_wagon").siege).toEqual([]);
    expect(countsByEdge(c).find((e) => e.edge === "north")!.count).toBe(2);
    const reordered: PartyConfig = { ...c, units: [...c.units].reverse() };
    expect(configKey(reordered)).toBe(configKey(c));
    expect(configKey(setStance(c, "b", "traps"))).not.toBe(configKey(c));
  });
});

describe("start cell from the list (the DOM alternative to dragging)", () => {
  it("along / depth round-trip on every edge and stay inside the band", async () => {
    const { alongOf, cellOnEdge, depthOf, edgeLength, setStart } = await import("./partyModel.ts");
    for (const edge of ["north", "east", "south", "west"] as const) {
      for (const along of [0, 7, edgeLength(edge) - 1]) {
        for (let depth = 0; depth < ENTRY_BAND_DEPTH; depth++) {
          const cell = cellOnEdge(edge, along, depth);
          expect(isEntryCell(cell, edge)).toBe(true);
          expect(alongOf(cell, edge)).toBe(along);
          expect(depthOf(cell, edge)).toBe(depth);
        }
      }
      expect(isEntryCell(cellOnEdge(edge, 99, 99), edge)).toBe(true);
    }
    const c = setStart(setEdge(addUnit(EMPTY, "a"), "a", "east"), "a", 5, 1);
    expect(c.units[0]!.cell).toEqual({ x: GRID_WIDTH - 2, y: 5 });
  });
});
