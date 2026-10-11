/**
 * Chunk 09, the pure model: resolution against a roster and the access gate, every
 * validation rule, canonical ordering and serialization, the scouting view, and the
 * structural fact that nothing in this package can touch a roster.
 */
import { FIXED_POINT_SCALE, TUNABLES, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTRY_EDGES,
  MAX_APPROACH_EDGES,
  PARTY_EDIT_COOLDOWN_MS,
  PARTY_SLOT_CAP,
  ParseError,
  SIEGE_SLOT_CAP,
  TARGETING_STANCES,
  cellCenter,
  entryBand,
  isEntryCell,
  partyConfigFromJson,
  partyFromJson,
  resolveParty,
  scoutParty,
  serializeParty,
  serializePartyConfig,
  siegeCounterEntry,
  type PartyConfig,
  type RosterUnit,
} from "../src/index.js";
import { ALLOW_ALL } from "./fixtures.js";

const ROSTER: RosterUnit[] = [
  { instanceId: "i-rider", typeId: "desert.dust_rider", mergeLevel: 1 },
  { instanceId: "i-digger", typeId: "desert.well_digger", mergeLevel: 3 },
  { instanceId: "i-sharp", typeId: "desert.sand_sharpshooter", mergeLevel: 1 },
  { instanceId: "i-canteen", typeId: "desert.canteen_carrier", mergeLevel: 2 },
  { instanceId: "i-coyote", typeId: "desert.coyote_pack", mergeLevel: 1 },
  { instanceId: "i-monkey", typeId: "desert.powder_monkey", mergeLevel: 1 },
  { instanceId: "i-bull", typeId: "desert.longhorn_bull", mergeLevel: 5 },
  { instanceId: "i-vaquero", typeId: "desert.vaquero", mergeLevel: 1 },
  { instanceId: "i-spare", typeId: "desert.dust_rider", mergeLevel: 1 },
];

const north = entryBand("north");
const south = entryBand("south");
const east = entryBand("east");
const west = entryBand("west");

function fullConfig(): PartyConfig {
  return {
    v: 1,
    units: [
      { ref: "i-vaquero", stance: "core", edge: "west", cell: west[3]! },
      { ref: "i-rider", stance: "nearest", edge: "north", cell: north[0]! },
      { ref: "i-digger", stance: "traps", edge: "north", cell: north[5]! },
      { ref: "i-sharp", stance: "nearest", edge: "south", cell: south[2]! },
      { ref: "i-canteen", stance: "core", edge: "east", cell: east[7]! },
      { ref: "i-coyote", stance: "nearest", edge: "north", cell: north[0]! },
      { ref: "i-monkey", stance: "traps", edge: "south", cell: south[9]! },
      { ref: "i-bull", stance: "core", edge: "east", cell: east[1]! },
    ],
    siege: ["siege.dousing_wagon", "siege.battering_wagon", "siege.fence_cutters"],
  };
}

function resolved(c: PartyConfig = fullConfig(), roster = ROSTER, access = ALLOW_ALL) {
  const r = resolveParty(c, roster, access);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe("tunables the party reads", () => {
  it("matches the deployment cap, allows all four edges, and has no edit cooldown", () => {
    expect(PARTY_SLOT_CAP).toBe(TUNABLES.DEPLOYMENT_SLOT_CAP);
    expect(PARTY_SLOT_CAP).toBe(8);
    expect(SIEGE_SLOT_CAP).toBe(3);
    expect(MAX_APPROACH_EDGES).toBe(ENTRY_EDGES.length);
    expect(PARTY_EDIT_COOLDOWN_MS).toBe(0);
    expect(TUNABLES.PARTIES_PER_ACCOUNT).toBe(1);
    expect([...TARGETING_STANCES]).toEqual(["nearest", "traps", "core"]);
  });
});

describe("resolveParty", () => {
  it("resolves a full party at both caps, split across all four edges, joined to the live roster", () => {
    const p = resolved();
    expect(p.units.length).toBe(PARTY_SLOT_CAP);
    expect(p.siege.length).toBe(SIEGE_SLOT_CAP);
    expect(p.units.find((u) => u.ref === "i-digger")).toMatchObject({ typeId: "desert.well_digger", mergeLevel: 3, stance: "traps", edge: "north" });
    expect(p.units.find((u) => u.ref === "i-bull")?.mergeLevel).toBe(5);
    expect(Object.isFrozen(p) && Object.isFrozen(p.units) && Object.isFrozen(p.units[0])).toBe(true);
  });

  it("an empty party resolves: that is every fresh account's state", () => {
    const p = resolved({ v: 1, units: [], siege: [] });
    expect(p).toEqual({ v: 1, units: [], siege: [] });
  });

  it("refuses the ninth unit and the fourth siege piece, server-side caps", () => {
    const c = fullConfig();
    const over = { ...c, units: [...c.units, { ref: "i-spare", stance: "core" as const, edge: "north" as const, cell: north[1]! }], siege: [...c.siege, "siege.blasting_crate"] };
    const r = resolveParty(over, ROSTER, ALLOW_ALL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code).sort()).toEqual(["slot_cap_siege", "slot_cap_units"]);
  });

  it("a merged unit costs one slot: eight level-5 units are legal where their 128 components would not be", () => {
    const roster = Array.from({ length: 8 }, (_, i) => ({ instanceId: `big-${i}`, typeId: "desert.longhorn_bull", mergeLevel: 5 }));
    const c: PartyConfig = { v: 1, units: roster.map((u, i) => ({ ref: u.instanceId, stance: "core", edge: "north", cell: north[i]! })), siege: [] };
    const p = resolved(c, roster);
    expect(scoutParty(p).units.every((u) => u.slotCost === 1 && u.mergeLevel === 5)).toBe(true);
  });

  it("a ref not in the roster (lost on a trip, consumed by a merge, or someone else's) is unknown_ref — the party is invalid, not silently trimmed", () => {
    const c = fullConfig();
    const r = resolveParty({ ...c, units: [...c.units.slice(1), { ref: "i-gone", stance: "core", edge: "north", cell: north[0]! }] }, ROSTER, ALLOW_ALL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual([{ code: "unknown_ref", message: "unit instance 'i-gone' is not in your roster (it may have been lost on a trip or consumed by a merge)", subject: "i-gone" }]);
  });

  it("the same instance twice is duplicate_ref; the same siege twice is duplicate_siege", () => {
    const c = fullConfig();
    const r = resolveParty({ ...c, units: [...c.units.slice(0, 7), { ...c.units[0]! }], siege: ["siege.dousing_wagon", "siege.dousing_wagon"] }, ROSTER, ALLOW_ALL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(["duplicate_ref", "duplicate_siege"]);
  });

  it("the access gate: a locked living type and a locked siege type are refused through the predicate", () => {
    const locked = new Set(["desert.vaquero", "siege.fence_cutters"]);
    const r = resolveParty(fullConfig(), ROSTER, (t) => !locked.has(t));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => [i.code, i.subject])).toEqual([
      ["type_locked", "desert.vaquero"],
      ["type_locked", "siege.fence_cutters"],
    ]);
  });

  it("stance, edge and band: exactly the three stances, exactly the four edges, cells inside the chosen edge's band", () => {
    const c = fullConfig();
    const units = c.units.map((u, i) => {
      if (i === 0) return { ...u, stance: "aggressive" as unknown as "core" };
      if (i === 1) return { ...u, edge: "up" as unknown as "north" };
      if (i === 2) return { ...u, cell: { x: 15, y: 15 } }; // the core: not a north band cell
      if (i === 3) return { ...u, cell: { x: 2, y: 2 } }; // on the lattice, in no band
      if (i === 4) return { ...u, cell: north[0]! }; // a north cell on an east-edge unit
      if (i === 5) return { ...u, cell: { x: -1, y: 0 } };
      return u;
    });
    const r = resolveParty({ ...c, units }, ROSTER, ALLOW_ALL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(["bad_stance", "bad_edge", "cell_off_band", "cell_off_band", "cell_off_band", "bad_cell"]);
  });

  it("every cell of every band is a legal start for its edge and for no other edge", () => {
    for (const edge of ENTRY_EDGES) {
      for (const cell of entryBand(edge)) {
        for (const other of ENTRY_EDGES) {
          const r = resolveParty({ v: 1, units: [{ ref: "i-rider", stance: "core", edge: other, cell }], siege: [] }, ROSTER, ALLOW_ALL);
          // A corner cell lies in two bands (north and west, say); every other band cell in exactly one.
          expect(r.ok, `${edge} ${JSON.stringify(cell)} as ${other}`).toBe(isEntryCell(cell, other));
          if (other === edge) expect(r.ok).toBe(true);
        }
      }
    }
    expect(entryBand("north").length).toBe(TUNABLES.GRID_WIDTH * TUNABLES.ENTRY_BAND_DEPTH);
  });

  it("a hostile body is refused with one `oversized` issue before any per-entry work", () => {
    const units = Array.from({ length: 1000 }, (_, i) => ({ ref: `x${i}`, stance: "core" as const, edge: "north" as const, cell: north[0]! }));
    const r = resolveParty({ v: 1, units, siege: [] }, ROSTER, ALLOW_ALL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(["oversized"]);
  });

  it("the roster's live merge level is what resolves: a de-merged instance rides at its new level, a party is never stale about it", () => {
    const after = ROSTER.map((u) => (u.instanceId === "i-bull" ? { ...u, mergeLevel: 4 } : u));
    expect(resolved(fullConfig(), after).units.find((u) => u.ref === "i-bull")?.mergeLevel).toBe(4);
  });
});

describe("canonical order and serialization", () => {
  it("the same party built in any order serializes byte-identically; units by ref, siege by type", () => {
    const c = fullConfig();
    const shuffled: PartyConfig = { ...c, units: [...c.units].reverse(), siege: [...c.siege].reverse() };
    expect(serializePartyConfig(shuffled)).toBe(serializePartyConfig(c));
    expect(serializeParty(resolved(shuffled))).toBe(serializeParty(resolved(c)));
    const p = resolved(shuffled);
    expect(p.units.map((u) => u.ref)).toEqual([...p.units.map((u) => u.ref)].sort());
    expect(p.siege.map((s) => s.typeId)).toEqual(["siege.battering_wagon", "siege.dousing_wagon", "siege.fence_cutters"]);
    expect(serializePartyConfig(c)).toMatch(/^\{"siege":\[/);
    expect(serializePartyConfig(c)).not.toMatch(/\s/);
  });

  it("round-trips through strict parsing, which refuses unknown keys, floats, bad enums and bad versions", () => {
    const c = fullConfig();
    const text = serializePartyConfig(c);
    expect(serializePartyConfig(partyConfigFromJson(JSON.parse(text)))).toBe(text);
    const p = resolved(c);
    expect(serializeParty(partyFromJson(JSON.parse(serializeParty(p))))).toBe(serializeParty(p));
    const bad = [
      { v: 2, units: [], siege: [] },
      { v: 1, units: [], siege: [], hp: 100 },
      { v: 1, units: [{ ref: "a", stance: "nearest", edge: "north", cell: { x: 0, y: 0 }, damage: 9 }], siege: [] },
      { v: 1, units: [{ ref: "a", stance: "nearest", edge: "north", cell: { x: 0.5, y: 0 } }], siege: [] },
      { v: 1, units: [{ ref: "a", stance: "berserk", edge: "north", cell: { x: 0, y: 0 } }], siege: [] },
      { v: 1, units: [{ ref: "a", stance: "nearest", edge: "northeast", cell: { x: 0, y: 0 } }], siege: [] },
      { v: 1, units: [], siege: [{ typeId: "siege.dousing_wagon" }] },
      [],
      null,
    ];
    for (const b of bad) expect(() => partyConfigFromJson(b), JSON.stringify(b)).toThrow(ParseError);
    // A served snapshot with an off-band cell or a duplicate ref is a bug, refused on read.
    expect(() => partyFromJson({ v: 1, units: [{ ref: "a", typeId: "desert.dust_rider", mergeLevel: 1, stance: "core", edge: "north", cell: { x: 15, y: 15 } }], siege: [] })).toThrow(ParseError);
    expect(() => partyFromJson({ v: 1, units: [], siege: [{ typeId: "siege.dousing_wagon" }, { typeId: "siege.dousing_wagon" }] })).toThrow(ParseError);
  });

  it("no number anywhere in a party, its config, its snapshot text or its scout view is fractional", () => {
    const p = resolved();
    const found: number[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "number") found.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(p);
    walk(scoutParty(p));
    expect(found.length).toBeGreaterThan(100);
    expect(found.filter((n) => !Number.isSafeInteger(n))).toEqual([]);
    for (const s of [serializeParty(p), serializePartyConfig(fullConfig())]) expect(/\d\.\d|[eE][-+]?\d/.test(s.replace(/"[^"]*"/g, ""))).toBe(false);
  });
});

describe("the scouting view — what a defender sees is what the owner previews", () => {
  it("lists every unit with both ratings (offense in use), merged HP, range, cooldown, ability, stance, edge and tick-zero position", () => {
    const p = resolved();
    const view = scoutParty(p);
    expect(view.units.length).toBe(8);
    expect(view.edges).toEqual(["north", "east", "south", "west"]);
    expect(view.unitSlots).toEqual({ used: 8, cap: PARTY_SLOT_CAP });
    expect(view.siegeSlots).toEqual({ used: 3, cap: SIEGE_SLOT_CAP });
    const bull = view.units.find((u) => u.ref === "i-bull")!;
    const type = getUnitType("desert.longhorn_bull")!;
    expect(bull).toMatchObject({
      typeId: type.id,
      displayName: type.displayName,
      affinity: type.affinity,
      mergeLevel: 5,
      slotCost: 1,
      stance: "core",
      edge: "east",
      ratingInUse: "offense",
      offense: type.offense,
      defense: type.defense,
      hp: scaleInt(type.hp, mergeStatMult(5)),
      moveSpeed: type.moveSpeed,
      attackRange: type.attackRange,
      attackCooldown: type.attackCooldown,
      ability: type.ability,
    });
    expect(bull.pos).toEqual(cellCenter(bull.cell));
    expect(bull.pos.x).toBe(bull.cell.x * FIXED_POINT_SCALE + Math.trunc(FIXED_POINT_SCALE / 2));
    // Ratings are never merge-scaled; HP is (chunk 03 QA B1). No blended number exists.
    expect(bull.offense).toBe(type.offense);
    expect(Object.keys(bull).some((k) => /power|strength|score/i.test(k))).toBe(false);
    expect(bull.hp).toBeGreaterThan(type.hp);
  });

  it("spells out every siege piece's counter: the category, the effect, and the exact fence tiers or trap types it hits", () => {
    const view = scoutParty(resolved());
    expect(view.siege.map((s) => s.typeId)).toEqual(["siege.battering_wagon", "siege.dousing_wagon", "siege.fence_cutters"]);
    const ram = view.siege[0]!;
    expect(ram).toMatchObject({ counters: { kind: "fence", category: "timber" }, effect: "accelerates", fenceDamageMult: TUNABLES.SIEGE_FENCE_DAMAGE_MULT, nullifiesTrap: false });
    expect(ram.targetTypeIds).toEqual(["fence.brush_pile", "fence.split_rail"]);
    const douse = view.siege[1]!;
    expect(douse).toMatchObject({ counters: { kind: "trap", category: "powder" }, effect: "bypasses", fenceDamageMult: null, nullifiesTrap: true });
    expect(douse.targetTypeIds).toEqual(["trap.powder_keg", "trap.tar_pot"]);
    // Siege has no stat, no damage number against units: it is a counter, never a buff.
    for (const s of view.siege) expect(Object.keys(s).some((k) => /damage$|offense|hp|attack/i.test(k))).toBe(false);
  });

  it("is a pure function of the resolved party: the same party scouts byte-identically, however the config was ordered", () => {
    const c = fullConfig();
    const a = JSON.stringify(scoutParty(resolved(c)));
    const b = JSON.stringify(scoutParty(resolved({ ...c, units: [...c.units].reverse(), siege: [...c.siege].reverse() })));
    expect(a).toBe(b);
    expect(siegeCounterEntry).toBeTypeOf("function");
  });
});

describe("structural guarantee: this package cannot touch a roster", () => {
  it("party.ts exports no function that mutates, damages, de-merges or removes a unit, and never writes a roster", () => {
    const src = readFileSync(join(__dirname, "..", "src", "party.ts"), "utf8");
    const exportedFns = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]!);
    expect(exportedFns.sort()).toEqual(["assertParty", "compareRefs", "freezeParty", "isTargetingStance", "normalizeParty", "normalizePartyConfig", "partyEdges", "resolveParty", "scoutParty", "scoutUnit", "siegeCounterEntry"]);
    expect(exportedFns.filter((f) => /kill|damage|demerge|consume|remove|lose|apply|attrit/i.test(f))).toEqual([]);
    // The roster is a readonly input; nothing here holds hp or a death flag for a party unit.
    expect(/readonly hp:/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").split("export interface ScoutUnit")[0]!)).toBe(false);
  });

  it("a resolved party is frozen: a caller holding it cannot change what will be served", () => {
    const p = resolved();
    expect(() => {
      (p.units[0] as { mergeLevel: number }).mergeLevel = 1;
    }).toThrow();
    expect(() => {
      (p.units as unknown as unknown[]).pop();
    }).toThrow();
  });
});
