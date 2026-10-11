/**
 * Synthetic fixture layouts and loadouts (chunk 10 DoD: "exist for testing without a
 * database"). Self-contained: every stat is a literal here, mirroring the shapes content
 * authors, so the resolver's tests never touch @caravan/content or the server.
 */
import {
  CORE_CELLS,
  CORE_CENTER,
  ENTRY_EDGES,
  GRID_HEIGHT,
  GRID_WIDTH,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
  cellCenter,
  entryBand,
  ringSegment,
  type Ability,
  type Battlefield,
  type BattlefieldFence,
  type BattlefieldPost,
  type BattlefieldTrap,
  type Cell,
  type EntryEdge,
  type Fixed,
  type Millis,
  type Party,
  type PartyUnit,
  type ResolveInput,
  type ResolverTunables,
  type Stance,
} from "../src/index.js";

export const fx = (n: number): Fixed => n as Fixed;
export const ms = (n: number): Millis => n as Millis;

/** The chunk 10 defaults, as @caravan/content's registry authors them. */
export const DEFAULT_TUNABLES: ResolverTunables = {
  tickRate: 20,
  battleLengthCapSeconds: 180,
  pathRecomputeIntervalMs: ms(500),
  unitRadius: fx(358), // 0.35 cells
  keyframeIntervalMs: ms(5000),
  pathConnectivity: 4,
};

/** A short fight for tests that only care about the first seconds. */
export const SHORT_TUNABLES: ResolverTunables = { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 30 };

export const DASH: Ability = { archetype: "dash", displayName: "Spur On", description: "Surges along its path.", cooldown: ms(9000), distance: fx(3584) };
export const HEAVY: Ability = { archetype: "heavy_strike", displayName: "Long Shot", description: "One aimed round.", cooldown: ms(15000), damageMult: fx(3584) };

export interface FenceSpec {
  segment: number;
  hp?: number;
  maxHp?: number;
  category?: "timber" | "wire" | "stone";
}

export function fence(spec: FenceSpec): BattlefieldFence {
  const seg = ringSegment(spec.segment);
  const maxHp = spec.maxHp ?? 300;
  return { ref: `f${spec.segment}`, segment: seg.index, cell: seg.cell, pos: cellCenter(seg.cell), tierId: "fence.brush_pile", category: spec.category ?? "timber", hp: spec.hp ?? maxHp, maxHp };
}

export function trap(ref: string, cell: Cell): BattlefieldTrap {
  return { ref, cell, pos: cellCenter(cell), typeId: "trap.spike_pit", category: "groundwork", affinity: "grit", damage: 250, effect: null };
}

export function post(ref: string, cell: Cell, over: Partial<BattlefieldPost> = {}): BattlefieldPost {
  return {
    ref,
    typeId: "desert.well_digger",
    mergeLevel: 1,
    stance: "guard",
    cell,
    pos: cellCenter(cell),
    hp: 1100,
    maxHp: 1100,
    affinity: "grit",
    defense: 100,
    moveSpeed: fx(1024),
    attackRange: fx(1024),
    attackCooldown: ms(1400),
    aggroRadius: fx(3072),
    leashDistance: fx(4096),
    ability: HEAVY,
    ...over,
  };
}

export interface FieldSpec {
  fences?: readonly BattlefieldFence[];
  traps?: readonly BattlefieldTrap[];
  posts?: readonly BattlefieldPost[];
}

export function battlefield(spec: FieldSpec = {}): Battlefield {
  return {
    v: 2,
    grid: { width: GRID_WIDTH, height: GRID_HEIGHT },
    pathConnectivity: 4,
    core: { cells: CORE_CELLS, center: CORE_CENTER },
    anchors: RING_ANCHORS,
    entries: ENTRY_EDGES.map((edge) => ({ edge, cells: entryBand(edge) })),
    fences: spec.fences ?? [],
    traps: spec.traps ?? [],
    posts: spec.posts ?? [],
  };
}

/** Every buyable segment except the listed gaps, at full HP. */
export function ringExcept(gaps: readonly number[], hp = 300): BattlefieldFence[] {
  const out: BattlefieldFence[] = [];
  for (let s = 0; s < PERIMETER_SEGMENTS; s++) if (!gaps.includes(s)) out.push(fence({ segment: s, maxHp: hp }));
  return out;
}

export interface UnitSpec {
  ref: string;
  stance?: Stance;
  edge?: EntryEdge;
  cell?: Cell;
  moveSpeed?: number;
  offense?: number;
  attackRange?: number;
  attackCooldown?: number;
  hp?: number;
}

export function unit(spec: UnitSpec): PartyUnit {
  const edge = spec.edge ?? "north";
  const cell = spec.cell ?? { x: 15, y: edge === "south" ? GRID_HEIGHT - 1 : 0 };
  const hp = spec.hp ?? 620;
  return {
    ref: spec.ref,
    typeId: "desert.dust_rider",
    mergeLevel: 1,
    stance: spec.stance ?? "core",
    entry: { edge, cell },
    hp,
    maxHp: hp,
    affinity: "beast",
    offense: spec.offense ?? 95,
    moveSpeed: fx(spec.moveSpeed ?? 1536), // 1.5 cells/s → 76 per tick
    attackRange: fx(spec.attackRange ?? 1024),
    attackCooldown: ms(spec.attackCooldown ?? 1000),
    ability: DASH,
  };
}

export function party(units: readonly PartyUnit[], siege: Party["siege"] = []): Party {
  return { v: 1, units, siege };
}

export function input(field: Battlefield, p: Party, tunables: ResolverTunables = DEFAULT_TUNABLES): ResolveInput {
  return { battlefield: field, party: p, tunables };
}

/** A plain JSON round trip so a fixture is data, not shared object identity. */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * QA-10 S2 regression: the reviewer's seeded random scenario `rand4` (probe rng 12345,
 * scenario index 4), in which RESOLVER_VERSION 1 let unit u1 clip through the corner of an
 * intact segment at tick 143. Pinned as literals so the corpus never depends on a PRNG.
 */
export function cornerClipScenario(): ResolveInput {
  const u = (ref: string, stance: Stance, edge: EntryEdge, cell: Cell, moveSpeed: number, offense: number, attackCooldown: number) => unit({ ref, stance, edge, cell, moveSpeed, offense, attackCooldown });
  return input(
    battlefield({ fences: ringExcept([3, 10, 12, 16, 17], 100), traps: [trap("t0", { x: 15, y: 12 }), trap("t1", { x: 8, y: 8 })] }),
    party([
      u("u0", "traps", "north", { x: 17, y: 0 }, 1024, 40, 1800),
      u("u1", "nearest", "north", { x: 10, y: 1 }, 1536, 110, 1000),
      u("u2", "nearest", "north", { x: 19, y: 0 }, 1536, 40, 800),
      u("u3", "nearest", "west", { x: 0, y: 16 }, 1536, 110, 1000),
      u("u4", "traps", "north", { x: 31, y: 0 }, 1024, 95, 1800),
      u("u5", "traps", "west", { x: 0, y: 18 }, 1024, 40, 1000),
    ]),
    { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 60 },
  );
}

/** The scenarios the determinism harness runs. Keep this list growing in chunks 11–13. */
export function scenarios(): { name: string; input: ResolveInput }[] {
  const north = (ref: string, stance: Stance, x: number) => unit({ ref, stance, edge: "north", cell: { x, y: 1 } });
  const south = (ref: string, stance: Stance, x: number) => unit({ ref, stance, edge: "south", cell: { x, y: GRID_HEIGHT - 2 } });
  return [
    { name: "open-field-core", input: input(battlefield(), party([north("a", "core", 15)]), SHORT_TUNABLES) },
    { name: "gapped-ring-three-stances", input: input(battlefield({ fences: ringExcept([3, 17]), traps: [trap("t1", { x: 13, y: 13 }), trap("t2", { x: 17, y: 18 })], posts: [post("p1", { x: 15, y: 13 }), post("p2", { x: 14, y: 17 })] }), party([north("a", "core", 15), north("b", "nearest", 20), south("c", "traps", 10), south("d", "core", 15)]), SHORT_TUNABLES) },
    { name: "sealed-ring-breach", input: input(battlefield({ fences: ringExcept([], 100), posts: [post("p1", { x: 15, y: 14 })] }), party([north("a", "core", 15), unit({ ref: "b", stance: "nearest", edge: "west", cell: { x: 0, y: 15 } })]), SHORT_TUNABLES) },
    { name: "full-length-mixed", input: input(battlefield({ fences: ringExcept([0, 1, 2, 3, 4, 5, 6, 7]), traps: [trap("t1", { x: 11, y: 10 })], posts: [post("p1", { x: 15, y: 12 }), post("p2", { x: 18, y: 16 })] }), party([north("a", "core", 2), north("b", "nearest", 29), south("c", "traps", 15), unit({ ref: "d", stance: "core", edge: "east", cell: { x: 31, y: 3 } })])) },
    { name: "corner-clip-rand4", input: cornerClipScenario() },
    { name: "sealed-ring-1e6-hp", input: input(battlefield({ fences: ringExcept([], 1_000_000) }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, offense: 1 })]), SHORT_TUNABLES) },
  ];
}
