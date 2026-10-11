/**
 * Chunk 13 — `toResolverParty` (the served standing party as the resolver sees it) and
 * `resolutionContent` (what the server hashes into every encounter job, QA-15 S3).
 */
import { CONTENT, TUNABLES, getSiegeType, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
import { CORE_CELLS, CORE_CENTER, ENTRY_EDGES, GRID_HEIGHT, GRID_WIDTH, RING_ANCHORS, assertResolveInput, entryBand, resolve, type ResolveInput } from "@caravan/resolver";
import { describe, expect, it } from "vitest";
import { RESOLUTION_COPY_KEYS, RESOLUTION_STAT_KEYS, resolutionContent, resolverTunables, toResolverParty, type Party } from "../src/index.js";

const party: Party = {
  v: 1,
  units: [
    { ref: "u2", typeId: "desert.well_digger", mergeLevel: 3, stance: "core", edge: "south", cell: entryBand("south")[4]! },
    { ref: "u1", typeId: "desert.dust_rider", mergeLevel: 1, stance: "nearest", edge: "north", cell: entryBand("north")[2]! },
  ],
  siege: [{ typeId: "siege.bridging_planks" }, { typeId: "siege.battering_wagon" }],
};

describe("toResolverParty", () => {
  it("joins the owner's choices with content stats: full HP (a template), merged max HP, the UNSCALED offense rating, ref order; siege by type", () => {
    const p = toResolverParty(party);
    expect(p.units.map((u) => u.ref)).toEqual(["u1", "u2"]);
    const digger = getUnitType("desert.well_digger")!;
    const u2 = p.units[1]!;
    expect(u2).toMatchObject({ typeId: "desert.well_digger", mergeLevel: 3, stance: "core", entry: { edge: "south", cell: entryBand("south")[4] }, affinity: digger.affinity, offense: digger.offense, moveSpeed: digger.moveSpeed, attackRange: digger.attackRange, attackCooldown: digger.attackCooldown, ability: digger.ability });
    expect(u2.maxHp).toBe(scaleInt(digger.hp, mergeStatMult(3)));
    expect(u2.hp).toBe(u2.maxHp);
    expect(p.siege).toEqual([
      { ref: "siege.battering_wagon", typeId: "siege.battering_wagon", counters: getSiegeType("siege.battering_wagon")!.counters },
      { ref: "siege.bridging_planks", typeId: "siege.bridging_planks", counters: getSiegeType("siege.bridging_planks")!.counters },
    ]);
  });

  it("is accepted by the resolver's input contract and resolves to an end condition", () => {
    const input: ResolveInput = {
      battlefield: { v: 2, grid: { width: GRID_WIDTH, height: GRID_HEIGHT }, pathConnectivity: 4, core: { cells: CORE_CELLS, center: CORE_CENTER }, anchors: RING_ANCHORS, entries: ENTRY_EDGES.map((edge) => ({ edge, cells: entryBand(edge) })), fences: [], traps: [], posts: [] },
      party: toResolverParty(party),
      tunables: resolverTunables(),
    };
    expect(() => assertResolveInput(JSON.parse(JSON.stringify(input)))).not.toThrow();
    expect(resolve(JSON.parse(JSON.stringify(input))).outcome.kind).toBe("caravan_overrun"); // an empty circle falls
  });

  it("refuses an unknown type", () => {
    expect(() => toResolverParty({ ...party, units: [{ ...party.units[0]!, typeId: "desert.nope" }] })).toThrow(/unknown unit type/);
    expect(() => toResolverParty({ ...party, siege: [{ typeId: "siege.nope" }] })).toThrow(/unknown siege type/);
  });
});

describe("resolutionContent", () => {
  it("carries every content table a resolution reads and the resolver tunables — and nothing account-shaped", () => {
    const c = resolutionContent();
    expect(Object.keys(c).sort()).toEqual(["fences", "siege", "traps", "tunables", "units"]);
    expect(c.tunables).toEqual(resolverTunables());
    expect(c.tunables.tickRate).toBe(TUNABLES.TICK_RATE);
    expect(JSON.stringify(c)).not.toMatch(/account|coin_balance|purchase|entitlement/i);
  });
});

describe("resolutionContent is the stat projection, never the copy (QA-13 D3)", () => {
  const key = (c: unknown) => JSON.stringify(c);
  it("every key of every content type is a stat (hashed) or copy (not hashed): a new stat cannot escape the hash", () => {
    const tables = { units: CONTENT.units, traps: CONTENT.traps, siege: CONTENT.siege, fences: CONTENT.fences } as const;
    for (const [table, rows] of Object.entries(tables)) {
      const stats: readonly string[] = RESOLUTION_STAT_KEYS[table as keyof typeof RESOLUTION_STAT_KEYS];
      for (const row of rows as readonly object[]) {
        for (const k of Object.keys(row)) expect(stats.includes(k) || RESOLUTION_COPY_KEYS.includes(k), `${table}.${k}`).toBe(true);
      }
    }
    const json = key(resolutionContent());
    for (const u of CONTENT.units) {
      expect(json).not.toContain(u.displayName);
      expect(json).not.toContain(u.ability.description);
    }
  });

  it("a description-only or name-only edit leaves the projection unchanged; a stat edit changes it", () => {
    const base = key(resolutionContent());
    const u0 = CONTENT.units[0]!;
    const copyEdit = {
      ...CONTENT,
      units: [{ ...u0, displayName: "Renamed", flavor: "New flavor", ability: { ...u0.ability, description: "Reworded.", displayName: "New name" } }, ...CONTENT.units.slice(1)],
      traps: [{ ...CONTENT.traps[0]!, flavor: "x", displayName: "y" }, ...CONTENT.traps.slice(1)],
    };
    expect(key(resolutionContent(copyEdit as typeof CONTENT))).toBe(base);
    const statEdit = { ...CONTENT, units: [{ ...u0, offense: u0.offense + 1 }, ...CONTENT.units.slice(1)] };
    expect(key(resolutionContent(statEdit as typeof CONTENT))).not.toBe(base);
    const abilityEdit = { ...CONTENT, units: [{ ...u0, ability: { ...u0.ability, cooldown: u0.ability.cooldown + 50 } }, ...CONTENT.units.slice(1)] };
    expect(key(resolutionContent(abilityEdit as typeof CONTENT))).not.toBe(base);
    const trapEdit = { ...CONTENT, traps: [{ ...CONTENT.traps[0]!, damage: CONTENT.traps[0]!.damage + 1 }, ...CONTENT.traps.slice(1)] };
    expect(key(resolutionContent(trapEdit as typeof CONTENT))).not.toBe(base);
  });
});
