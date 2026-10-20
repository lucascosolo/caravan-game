/** Final play-test review round 4 D2: the one-tap raise varies its edges and stances, deterministically. */
import { LIVING_UNIT_TYPES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { ENTRY_EDGES, isEntryCell, partyEdges, raiseOrder, raiseStance, raiseUnits, starterEdges } from "../src/index.js";

const caravans = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const roster = (caravanId: string, types: readonly string[]) => types.map((typeId, i) => ({ instanceId: `${caravanId}-u${i}`, caravanId, typeId, unlocked: true }));
const desert = LIVING_UNIT_TYPES.filter((t) => t.regionId === "desert").map((t) => t.id);

describe("round 4 D2: the raise", () => {
  it("starter edges are two adjacent edges, a fixed function of the caravan id, and caravans differ", () => {
    const seen = new Set<string>();
    for (const c of caravans) {
      const [a, b] = starterEdges(c);
      expect(starterEdges(c)).toEqual([a, b]);
      expect(ENTRY_EDGES.indexOf(b)).toBe((ENTRY_EDGES.indexOf(a) + 1) % ENTRY_EDGES.length);
      seen.add(a);
    }
    expect(seen.size).toBe(ENTRY_EDGES.length);
  });

  it("each unit's stance comes from its ability: breakers and bursts take the traps, everything else (dash too, since BALANCE-LOG pass 8) the nearest", () => {
    for (const t of LIVING_UNIT_TYPES) {
      const want = t.ability.archetype === "structure_breaker" || t.ability.archetype === "burst_radius" ? "traps" : "nearest";
      expect(raiseStance(t.id), t.id).toBe(want);
    }
    expect(raiseStance("no.such_type")).toBe("nearest");
    // Not all one stance across a region.
    expect(new Set(desert.map(raiseStance)).size).toBeGreaterThan(1);
  });

  it("raised units alternate over the two edges, each on its own band, up to max; saved units are untouched and never cut", () => {
    const c = caravans[3]!;
    const [a, b] = starterEdges(c);
    const r = roster(c, desert);
    const units = raiseUnits({ v: 1, units: [], siege: [] }, r, 5);
    expect(units).toHaveLength(5);
    expect(units.map((u) => u.edge)).toEqual([a, b, a, b, a]);
    for (const u of units) expect(isEntryCell(u.cell, u.edge)).toBe(true);
    expect(units.map((u) => u.stance)).toEqual(r.slice(0, 5).map((x) => raiseStance(x.typeId)));
    expect(new Set(units.map((u) => `${u.cell.x},${u.cell.y}`)).size).toBe(5);
    expect([...partyEdges({ units })].sort()).toEqual([a, b].sort());
    // A refill keeps the saved units as saved and continues the alternation.
    const saved = units.slice(0, 2).map((u) => ({ ...u, stance: "core" as const }));
    const refill = raiseUnits({ v: 1, units: saved, siege: [] }, r, 5);
    expect(refill.slice(0, 2)).toEqual(saved);
    expect(refill.slice(2).map((u) => u.edge)).toEqual([a, b, a]);
    // Locked units are skipped; a saved party over max is never cut.
    expect(raiseUnits({ v: 1, units: [], siege: [] }, r.map((x, i) => ({ ...x, unlocked: i !== 0 })), 5)[0]!.ref).toBe(r[1]!.instanceId);
    expect(raiseUnits({ v: 1, units, siege: [] }, r, 3)).toEqual(units);
  });
});

describe("raiseOrder (BALANCE-LOG pass 8): the guide's raise takes unit types round-robin", () => {
  it("interleaves types in first-appearance order, each type's units in roster order; stable and complete", () => {
    const r = ["g1", "g2", "g3", "t1", "t2", "t3", "g4"].map((id) => ({ id, typeId: id[0]! }));
    expect(raiseOrder(r).map((x) => x.id)).toEqual(["g1", "t1", "g2", "t2", "g3", "t3", "g4"]);
    expect(raiseOrder([])).toEqual([]);
    expect(raiseOrder([{ typeId: "a" }])).toHaveLength(1);
  });
});
