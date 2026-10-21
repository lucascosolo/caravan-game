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
  type ResolveOutput,
  type ResolverTunables,
  type LogEvent,
  type Stance,
  assertResolveInput,
  initialState,
  normalizeInput,
  runTick,
} from "../src/index.js";
import { CHATTER_GUARD_INPUT, RAND93_INPUT, SHIELD_BASELINE_INPUT, SHIELD_HOLD_INPUT } from "./qa11-fixtures.js";

export const fx = (n: number): Fixed => n as Fixed;
export const ms = (n: number): Millis => n as Millis;

/** The chunk 10 and 11 defaults, as @caravan/content's registry authors them. */
export const DEFAULT_TUNABLES: ResolverTunables = {
  tickRate: 20,
  battleLengthCapSeconds: 180,
  pathRecomputeIntervalMs: ms(500),
  unitRadius: fx(358), // 0.35 cells
  keyframeIntervalMs: ms(5000),
  pathConnectivity: 4,
  affinityAdvantageMult: fx(1280), // ×1.25
  affinityDisadvantageMult: fx(819), // ×0.80
  affinityNeutralMult: fx(1024),
  // Grit beats Powder, Powder beats Beast, Beast beats Grit (content's affinity.ts).
  affinityMatrix: {
    grit: { grit: "neutral", powder: "advantage", beast: "disadvantage" },
    powder: { grit: "disadvantage", powder: "neutral", beast: "advantage" },
    beast: { grit: "advantage", powder: "disadvantage", beast: "neutral" },
  },
  mergeStatMultByLevel: [fx(0), fx(1024), fx(1280), fx(1600), fx(2000), fx(2500)],
  trapTriggerRadius: fx(768), // 0.75 cells
  siegeFenceDamageMult: fx(4096), // ×4
  leashHysteresisMult: fx(819), // ×0.80
  abilityFirstUseDelayMult: fx(1024), // ×1.0: the first use waits a full cooldown
  structureBreakerFirstUseMult: fx(256), // ×0.25: a breaker's first use (QA-12 D2)
  fenceHitSegmentCap: fx(512), // ×0.50 of a segment's max HP per unit per tick, every fence hit summed (QA-12 D1)
};

/** (radius + UNIT_RADIUS)²: the REACH rule's squared threshold for the default unit radius. */
export const reachSq = (radius: number): number => (radius + 358) * (radius + 358);

/** A short fight for tests that only care about the first seconds. */
export const SHORT_TUNABLES: ResolverTunables = { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 30 };

/**
 * Chunk 12: the same tunables with the first ability use pushed past the tick cap
 * (abilityFirstUseDelayMult and structureBreakerFirstUseMult ×64, the input bound — a 9 s
 * dash first readies at tick 11 520).
 * For the chunk 10/11 tests that pin a movement or combat rule tick-exactly in isolation;
 * every unit still HAS its ability, it just never comes off its first cooldown. The fights
 * that pin ability rules use the real delay.
 */
export function quiet(t: ResolverTunables): ResolverTunables {
  return { ...t, abilityFirstUseDelayMult: fx(64 * 1024), structureBreakerFirstUseMult: fx(64 * 1024) };
}
export const QUIET_SHORT_TUNABLES: ResolverTunables = quiet(SHORT_TUNABLES);

export const DASH: Ability = { archetype: "dash", displayName: "Spur On", description: "Surges along its path.", cooldown: ms(9000), distance: fx(3584) };
export const HEAVY: Ability = { archetype: "heavy_strike", displayName: "Long Shot", description: "One aimed round.", cooldown: ms(15000), damageMult: fx(3584) };
/** Chunk 12: one literal per remaining archetype, at content's reference values. */
export const BURST: Ability = { archetype: "burst_radius", displayName: "Lit Fuse", description: "Hits every enemy within 2 cells.", cooldown: ms(12000), radius: fx(2048), damageMult: fx(1536) };
export const HEAL: Ability = { archetype: "heal_radius", displayName: "Canteen", description: "Restores 10% max HP to allies within 2.5 cells.", cooldown: ms(14000), radius: fx(2560), healFraction: fx(102), charges: 4 };
export const BUFF: Ability = { archetype: "self_buff", displayName: "Pack Fury", description: "+30% damage for 5 seconds.", cooldown: ms(10000), damageBonus: fx(307), duration: ms(5000) };
export const BREAKER: Ability = { archetype: "structure_breaker", displayName: "Ram", description: "Rams a fence segment for 5x.", cooldown: ms(12000), fenceDamageMult: fx(5120) };
export const ALL_ABILITIES: readonly Ability[] = [BURST, HEAVY, HEAL, BUFF, DASH, BREAKER];

/**
 * Chunk 12 determinism corpus: ability-heavy fights. Every archetype on both sides, healers
 * on both sides with full-length fights (charges run out), dashes against a sealed ring,
 * breakers with the countering siege, and a same-tick heal-vs-burst set-up.
 */
export function abilityScenarios(): { name: string; input: ResolveInput }[] {
  const at = (ref: string, ability: Ability, edge: EntryEdge, cell: Cell, over: Partial<UnitSpec> = {}) => unit({ ref, ability, edge, cell, ...over });
  const timberSiege = { ref: "s", typeId: "siege.battering_wagon", counters: { kind: "fence", category: "timber" } } as const;
  return [
    {
      name: "abilities-all-six-both-sides",
      input: input(
        battlefield({
          fences: ringExcept([15, 4, 7, 12], 400),
          traps: [trap("t1", { x: 14, y: 9 }), trap("t2", { x: 21, y: 16 }, { effect: ROOT }), trap("t3", { x: 9, y: 16 }, { effect: SLOW })],
          posts: ALL_ABILITIES.map((ability, k) => post(`p${k}`, [{ x: 13, y: 13 }, { x: 17, y: 13 }, { x: 13, y: 17 }, { x: 17, y: 17 }, { x: 15, y: 13 }, { x: 15, y: 17 }][k]!, { ability, stance: (["guard", "hold", "guard", "reserve", "guard", "hold"] as const)[k]!, mergeLevel: 1 + (k % 5) })),
        }),
        party(
          [
            at("a0", BURST, "north", { x: 12, y: 0 }, { stance: "nearest" }),
            at("a1", HEAVY, "north", { x: 18, y: 1 }, { stance: "nearest", attackRange: 4096 }),
            at("a2", HEAL, "east", { x: 31, y: 14 }, { stance: "nearest" }),
            at("a3", BUFF, "east", { x: 30, y: 17 }, { stance: "nearest", mergeLevel: 3 }),
            at("a4", DASH, "south", { x: 16, y: 31 }, { stance: "core", moveSpeed: 2600 }),
            at("a5", BREAKER, "west", { x: 0, y: 12 }, { stance: "core", hp: 1400 }),
          ],
          [timberSiege],
        ),
      ),
    },
    {
      name: "abilities-dash-sealed-ring",
      input: input(battlefield({ fences: ringExcept([], 300), traps: [trap("t", { x: 14, y: 6 })] }), party([unit({ ref: "a" }), unit({ ref: "b", cell: { x: 0, y: 16 }, edge: "west" }), unit({ ref: "c", cell: { x: 31, y: 20 }, edge: "east", moveSpeed: 2600 })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(256) }),
    },
    {
      name: "abilities-breaker-siege-stone",
      input: input(
        battlefield({ fences: ringExcept([], 1000).map((f) => ({ ...f, category: "stone" as const })), posts: [post("p", { x: 15, y: 13 }, { ability: HEAL })] }),
        party([unit({ ref: "a", ability: BREAKER, mergeLevel: 5, offense: 120 }), unit({ ref: "b", ability: BREAKER, cell: { x: 0, y: 16 }, edge: "west" })], [{ ref: "s", typeId: "siege.blasting_crate", counters: { kind: "fence", category: "stone" } }]),
        { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0) },
      ),
    },
    {
      name: "abilities-healers-full-length",
      input: input(
        battlefield({ posts: [post("h1", { x: 14, y: 8 }, { ability: HEAL, stance: "hold" }), post("h2", { x: 14, y: 8 }, { ability: HEAL, stance: "hold" }), post("t", { x: 14, y: 9 }, { stance: "hold", hp: 3000, maxHp: 3000 })] }),
        party([unit({ ref: "a", stance: "nearest", hp: 4000, ability: HEAL }), unit({ ref: "b", stance: "nearest", hp: 2000, ability: BURST }), unit({ ref: "c", stance: "nearest", ability: BUFF })]),
      ),
    },
    {
      name: "abilities-same-tick-heal-vs-burst",
      input: input(
        battlefield({ posts: [post("h", { x: 14, y: 6 }, { ability: HEAL, stance: "hold" }), post("p", { x: 14, y: 5 }, { stance: "hold", hp: 300, maxHp: 1100 })] }),
        // A 1-tick burst: it fires every tick it has a target, so the heal that answers it lands on a burst tick.
        party([unit({ ref: "a", stance: "nearest", ability: { ...BURST, cooldown: ms(50) } as Ability, hp: 5000 }), unit({ ref: "b", stance: "nearest", ability: HEAL, hp: 5000 })]),
        { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0) },
      ),
    },
    // QA-12 B1 (the reviewer's p6b_dashcore.ts): a 150-HP dasher at 1 cell/s walks south through
    // gap 3 and dashes 3.5 cells over a lethal spike pit (199 after affinity) onto the core. Its
    // dash path springs the pit in phase 7 of the dash tick, before any core_reached.
    { name: "qa12-dash-over-trap-onto-core", input: qa12DashCoreInput(1138, 30) },
    // The same with the dash on the LAST tick of a 10 s cap (tick 199): still tested.
    { name: "qa12-dash-over-trap-tick-cap", input: qa12DashCoreInput(1133, 10) },
  ];
}

/** QA-12 B1 fixture: see abilityScenarios. `firstUse` is abilityFirstUseDelayMult (×1/1024), `capSeconds` the battle length. */
export function qa12DashCoreInput(firstUse: number, capSeconds: number): ResolveInput {
  return input(
    battlefield({ fences: ringExcept([15], 300), traps: [trap("t", { x: 14, y: 13 }, { damage: 250 })] }),
    party([unit({ ref: "a", hp: 150, stance: "core", moveSpeed: 1024, cell: { x: 14, y: 1 } })]),
    { ...SHORT_TUNABLES, battleLengthCapSeconds: capSeconds, abilityFirstUseDelayMult: fx(firstUse) },
  );
}

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

export function trap(ref: string, cell: Cell, over: Partial<BattlefieldTrap> = {}): BattlefieldTrap {
  return { ref, cell, pos: cellCenter(cell), typeId: "trap.spike_pit", category: "groundwork", affinity: "grit", damage: 250, effect: null, ...over };
}

/** Content's trap effects, as literals: jaw trap root (1.5 s) and the slow default (−40 % for 3 s). */
export const ROOT: BattlefieldTrap["effect"] = { kind: "root", duration: ms(1500) };
export const SLOW: BattlefieldTrap["effect"] = { kind: "slow", magnitude: fx(410), duration: ms(3000) };

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
    v: 3,
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
  affinity?: PartyUnit["affinity"];
  mergeLevel?: number;
  ability?: Ability;
}

export function unit(spec: UnitSpec): PartyUnit {
  const edge = spec.edge ?? "north";
  const cell = spec.cell ?? { x: edge === "south" ? 16 : 14, y: edge === "south" ? GRID_HEIGHT - 1 : 0 };
  const hp = spec.hp ?? 620;
  return {
    ref: spec.ref,
    typeId: "desert.dust_rider",
    mergeLevel: spec.mergeLevel ?? 1,
    stance: spec.stance ?? "core",
    entry: { edge, cell },
    hp,
    maxHp: hp,
    affinity: spec.affinity ?? "beast",
    offense: spec.offense ?? 95,
    moveSpeed: fx(spec.moveSpeed ?? 1536), // 1.5 cells/s → 76 per tick
    attackRange: fx(spec.attackRange ?? 1024),
    attackCooldown: ms(spec.attackCooldown ?? 1000),
    ability: spec.ability ?? DASH,
  };
}

export function party(units: readonly PartyUnit[], siege: Party["siege"] = []): Party {
  return { v: 1, units, siege };
}

export function input(field: Battlefield, p: Party, tunables: ResolverTunables = DEFAULT_TUNABLES): ResolveInput {
  return { battlefield: field, party: p, tunables };
}

/**
 * Chunk 13 — MECHANIC ISOLATION for the chunk 10–12 tests (like `quiet`): runs the tick loop
 * to TICK_CAP with the end conditions SWITCHED OFF, so a test pinning a movement, leash or
 * trap rule can watch what happens after a raider would have ended the fight (reaching the
 * core, the last raider dying). Same tick loop, same log, same summaries as `resolve`, minus
 * `endOfTick`; `outcome` is reported as a stalemate at the cap. Test-only: production has no
 * way to switch end conditions off (resolve.ts always checks them), and the golden corpus is
 * run through `resolve` itself.
 */
export function runToCap(raw: ResolveInput): ResolveOutput {
  assertResolveInput(raw);
  const state = initialState(normalizeInput(raw));
  const startHp = state.fences.map((f) => f.hp);
  const log: LogEvent[] = [];
  for (const u of state.units) log.push({ t: 0, k: "spawn", u: u.id, x: u.x, y: u.y });
  for (; state.tick < state.tickCap; state.tick++) runTick(state, log);
  return {
    resolverVersion: 0,
    tickRate: state.tickRate,
    tickCap: state.tickCap,
    keyframeInterval: state.keyframeInterval,
    ticks: state.tickCap,
    end: "tick_cap",
    outcome: { kind: "stalemate", end: "tick_cap", endTick: state.tickCap - 1, depth: 0, deepestUnit: -1 },
    units: state.units.map((u) => ({ id: u.id, side: u.side, ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, ability: u.ability.archetype, x: u.x, y: u.y, startHp: u.startHp, hp: u.hp, maxHp: u.maxHp, alive: u.alive, reachedCoreTick: u.reachedCoreTick, diedTick: u.diedTick })),
    fences: state.fences.map((f) => ({ f: f.index, ref: f.ref, segment: f.segment, tierId: f.tierId, category: f.category, startHp: startHp[f.index]!, hp: f.hp, maxHp: f.maxHp, intact: f.intact, brokenTick: f.brokenTick })),
    traps: state.traps.map((t) => ({ i: t.index, ref: t.ref, typeId: t.typeId, x: t.pos.x, y: t.pos.y, spent: t.spent, spentTick: t.spentTick })),
    log,
    work: { ticks: state.tickCap, ...state.work },
  };
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
    battlefield({ fences: ringExcept([15, 4, 12, 7, 1], 100), traps: [trap("t0", { x: 14, y: 11 }), trap("t1", { x: 8, y: 8 })] }),
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

/**
 * Chunk 11's budget scenario: 16 attackers (all three stances, all three affinities, every
 * merge level, a mix of speeds and ranges) against 8 posts (all three stances) behind all 16
 * fence segments, with 6 traps (damage, slow, root) and two siege pieces, for the full 180 s.
 * The performance check and the log-size measurement run it. Since chunk 12 every unit and
 * post carries one of the six archetypes in rotation (ALL_ABILITIES), so the budget is
 * measured with abilities firing.
 */
export function fullLoadScenario(): ResolveInput {
  const affinities = ["grit", "powder", "beast"] as const;
  const stances: Stance[] = ["core", "nearest", "traps"];
  const edges: EntryEdge[] = ["north", "east", "south", "west"];
  const entryCell = (edge: EntryEdge, k: number): Cell => {
    const along = 2 + ((k * 7) % 28);
    if (edge === "north") return { x: along, y: k % 2 };
    if (edge === "south") return { x: along, y: GRID_HEIGHT - 1 - (k % 2) };
    if (edge === "west") return { x: k % 2, y: along };
    return { x: GRID_WIDTH - 1 - (k % 2), y: along };
  };
  const units: PartyUnit[] = [];
  for (let k = 0; k < 16; k++) {
    units.push(
      unit({
        ref: `u${k < 10 ? "0" : ""}${k}`,
        stance: stances[k % 3]!,
        edge: edges[k % 4]!,
        cell: entryCell(edges[k % 4]!, k),
        affinity: affinities[k % 3]!,
        mergeLevel: 1 + (k % 5),
        offense: 40 + ((k * 13) % 81),
        hp: 300 + ((k * 211) % 1101),
        moveSpeed: 1024 + ((k * 397) % 2049),
        attackRange: k % 4 === 3 ? 4096 : 1024,
        attackCooldown: 400 + ((k * 331) % 2101),
        ability: ALL_ABILITIES[k % 6]!,
      }),
    );
  }
  const postStances = ["guard", "hold", "reserve"] as const;
  const postCells: Cell[] = [
    { x: 13, y: 12 },
    { x: 17, y: 12 },
    { x: 12, y: 15 },
    { x: 18, y: 15 },
    { x: 13, y: 18 },
    { x: 17, y: 18 },
    { x: 15, y: 13 },
    { x: 15, y: 17 },
  ];
  const posts = postCells.map((cell, k) =>
    post(`p${k}`, cell, {
      stance: postStances[k % 3]!,
      affinity: affinities[(k + 1) % 3]!,
      mergeLevel: 1 + (k % 5),
      defense: 40 + ((k * 17) % 81),
      hp: 400 + ((k * 173) % 1001),
      maxHp: 400 + ((k * 173) % 1001),
      attackRange: k % 2 === 0 ? fx(1024) : fx(4096),
      attackCooldown: ms(500 + ((k * 277) % 2001)),
      aggroRadius: fx(3072 + 1024 * (k % 3)),
      leashDistance: fx(4096 + 1024 * (k % 2)),
      ability: ALL_ABILITIES[(k + 3) % 6]!,
    }),
  );
  const traps: BattlefieldTrap[] = [
    trap("t0", { x: 14, y: 9 }),
    trap("t1", { x: 9, y: 16 }, { effect: SLOW }),
    trap("t2", { x: 21, y: 16 }, { effect: ROOT, category: "powder", affinity: "powder" }),
    trap("t3", { x: 16, y: 21 }, { category: "powder", affinity: "powder" }),
    trap("t4", { x: 10, y: 9 }, { effect: ROOT }),
    trap("t5", { x: 20, y: 21 }, { effect: SLOW, category: "powder", affinity: "powder" }),
  ];
  const fences = ringExcept([], 400).map((f, i) => ({ ...f, category: (["timber", "wire", "stone"] as const)[i % 3]! }));
  return input(
    battlefield({ fences, traps, posts }),
    party(units, [
      { ref: "s0", typeId: "siege.battering_wagon", counters: { kind: "fence", category: "timber" } },
      { ref: "s1", typeId: "siege.bridging_planks", counters: { kind: "trap", category: "groundwork" } },
    ]),
  );
}

/**
 * QA-11 D1 (after the reviewer's p6_reserve, grizzly vs grizzly): a RESERVE post at (15,12),
 * right behind the gap at segment 3, and a `nearest` attacker that comes to the gap cell
 * (15,11) — a ring cell, so the post is not released — and attacks it from there. The post
 * must fire back from its post without moving.
 */
export function reserveFiresBackScenario(): ResolveInput {
  return input(
    battlefield({ fences: ringExcept([15, 5, 6, 7, 8, 9], 300), posts: [post("p", { x: 14, y: 11 }, { stance: "reserve", hp: 1300, maxHp: 1300, defense: 90 })] }),
    party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: 1300, offense: 90 })]),
    SHORT_TUNABLES,
  );
}

/** The scenarios the determinism harness runs. Keep this list growing in chunks 11–13. */
export function scenarios(): { name: string; input: ResolveInput }[] {
  const north = (ref: string, stance: Stance, x: number) => unit({ ref, stance, edge: "north", cell: { x, y: 1 } });
  const south = (ref: string, stance: Stance, x: number) => unit({ ref, stance, edge: "south", cell: { x, y: GRID_HEIGHT - 2 } });
  return [
    // ── chunk 12 ability scenarios ──
    ...abilityScenarios(),
    // ── chunk 11 QA round 1 (literal inputs, qa11-fixtures.ts; assertions in qa11.test.ts) ──
    { name: "qa11-chatter-guard", input: CHATTER_GUARD_INPUT },
    { name: "qa11-rand93", input: RAND93_INPUT },
    { name: "qa11-shield-hold", input: SHIELD_HOLD_INPUT },
    { name: "qa11-shield-baseline", input: SHIELD_BASELINE_INPUT },
    { name: "qa11-reserve-fires-back", input: reserveFiresBackScenario() },
    // ── chunk 11 combat scenarios ──
    {
      name: "combat-three-stances-traps-siege",
      input: input(
        battlefield({
          fences: ringExcept([15, 7], 300),
          traps: [trap("t1", { x: 14, y: 9 }, { effect: ROOT }), trap("t2", { x: 16, y: 21 }, { effect: SLOW, category: "powder", affinity: "powder" }), trap("t3", { x: 9, y: 16 })],
          posts: [post("g", { x: 13, y: 12 }), post("h", { x: 17, y: 12 }, { stance: "hold", affinity: "powder", attackRange: fx(4096) }), post("r", { x: 15, y: 18 }, { stance: "reserve", affinity: "beast", mergeLevel: 3 })],
        }),
        party([north("a", "nearest", 14), north("b", "core", 12), south("c", "traps", 16), unit({ ref: "d", stance: "nearest", edge: "west", cell: { x: 0, y: 16 }, affinity: "powder", mergeLevel: 2 })], [{ ref: "s", typeId: "siege.bridging_planks", counters: { kind: "trap", category: "groundwork" } }]),
        SHORT_TUNABLES,
      ),
    },
    {
      name: "combat-leash-oscillation",
      input: input(battlefield({ traps: [trap("t", { x: 14, y: 11 })], posts: [post("p", { x: 14, y: 9 }, { aggroRadius: fx(8192) })] }), party([unit({ ref: "a", edge: "south", cell: { x: 16, y: 31 } })]), SHORT_TUNABLES),
    },
    {
      name: "combat-affinity-mirror",
      input: input(
        battlefield({ posts: [post("pg", { x: 13, y: 8 }, { affinity: "grit" }), post("pp", { x: 14, y: 8 }, { affinity: "powder" }), post("pb", { x: 17, y: 8 }, { affinity: "beast" })] }),
        party([unit({ ref: "ag", stance: "nearest", cell: { x: 13, y: 0 }, affinity: "grit" }), unit({ ref: "ap", stance: "nearest", cell: { x: 14, y: 0 }, affinity: "powder" }), unit({ ref: "ab", stance: "nearest", cell: { x: 17, y: 0 }, affinity: "beast" })]),
        SHORT_TUNABLES,
      ),
    },
    { name: "combat-full-load-16v8v28", input: fullLoadScenario() },
    // ── chunk 10 scenarios ──
    { name: "open-field-core", input: input(battlefield(), party([north("a", "core", 14)]), SHORT_TUNABLES) },
    { name: "gapped-ring-three-stances", input: input(battlefield({ fences: ringExcept([15, 7]), traps: [trap("t1", { x: 13, y: 13 }), trap("t2", { x: 17, y: 18 })], posts: [post("p1", { x: 15, y: 13 }), post("p2", { x: 14, y: 17 })] }), party([north("a", "core", 14), north("b", "nearest", 20), south("c", "traps", 10), south("d", "core", 16)]), SHORT_TUNABLES) },
    { name: "sealed-ring-breach", input: input(battlefield({ fences: ringExcept([], 100), posts: [post("p1", { x: 15, y: 13 })] }), party([north("a", "core", 14), unit({ ref: "b", stance: "nearest", edge: "west", cell: { x: 0, y: 15 } })]), SHORT_TUNABLES) },
    { name: "full-length-mixed", input: input(battlefield({ fences: ringExcept([15, 0, 1, 2, 3, 4]), traps: [trap("t1", { x: 11, y: 10 })], posts: [post("p1", { x: 14, y: 12 }), post("p2", { x: 18, y: 16 })] }), party([north("a", "core", 2), north("b", "nearest", 29), south("c", "traps", 16), unit({ ref: "d", stance: "core", edge: "east", cell: { x: 31, y: 3 } })])) },
    { name: "corner-clip-rand4", input: cornerClipScenario() },
    { name: "sealed-ring-1e6-hp", input: input(battlefield({ fences: ringExcept([], 1_000_000) }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, offense: 1 })]), SHORT_TUNABLES) },
    // ── chunk 13: every chunk 10–12 boundary as a whole fight, the end-condition edges, the budget worst case ──
    ...boundaryScenarios(),
  ];
}

/**
 * Chunk 13 — the rest of the golden corpus. Every boundary rule chunks 10–12 pinned in a
 * transient test is here as a WHOLE FIGHT resolved by `resolve` (end conditions on), so its
 * log is a checked-in golden, plus the end-condition edges chunk 13 adds (an arrival or a wipe
 * on the cap tick, an arrival and a wipe on the same tick, a wipe that also kills the last
 * post, a stalemate with both sides alive and fighting) and the full-load worst case for the
 * log budget. Literals only; nothing depends on a PRNG.
 */
export function boundaryScenarios(): { name: string; input: ResolveInput }[] {
  const timber = (ref = "s") => ({ ref, typeId: "siege.battering_wagon", counters: { kind: "fence", category: "timber" } }) as const;
  const stone = (ref = "s") => ({ ref, typeId: "siege.blasting_crate", counters: { kind: "fence", category: "stone" } }) as const;
  const planks = (ref = "s") => ({ ref, typeId: "siege.bridging_planks", counters: { kind: "trap", category: "groundwork" } }) as const;
  const powderSiege = (ref = "s") => ({ ref, typeId: "siege.dousing_wagon", counters: { kind: "trap", category: "powder" } }) as const;
  const holdAt = (ref: string, cell: Cell, over: Partial<BattlefieldPost> = {}) => post(ref, cell, { stance: "hold", ...over });
  const BIG = 1_000_000;
  const stanceFight = (stance: "guard" | "hold" | "reserve") => input(battlefield({ fences: ringExcept([15]), posts: [post("p", { x: 13, y: 12 }, { stance })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 5000 })]), SHORT_TUNABLES);
  return [
    // ── chunk 10: movement, breaching, stances, tie-breaks ──
    { name: "c10-gap-detour-cheaper", input: input(battlefield({ fences: ringExcept([6], 1000) }), party([unit({ ref: "a", cell: { x: 14, y: 0 } })]), SHORT_TUNABLES) },
    { name: "c10-breach-vs-detour-boundary", input: input(battlefield({ fences: ringExcept([4], 95) }), party([unit({ ref: "a", cell: { x: 14, y: 0 } })]), SHORT_TUNABLES) },
    { name: "c10-two-units-one-segment-same-tick", input: input(battlefield({ fences: ringExcept([], 100) }), party([unit({ ref: "a", cell: { x: 14, y: 0 } }), unit({ ref: "b", cell: { x: 14, y: 0 } })]), QUIET_SHORT_TUNABLES) },
    { name: "c10-identical-units-overlap", input: input(battlefield({ fences: ringExcept([15]) }), party([unit({ ref: "a", cell: { x: 14, y: 0 } }), unit({ ref: "b", cell: { x: 14, y: 0 } })]), SHORT_TUNABLES) },
    { name: "c10-nearest-tie-lowest-id", input: input(battlefield({ posts: [post("p1", { x: 12, y: 6 }), post("p2", { x: 16, y: 6 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 } }), unit({ ref: "b", stance: "nearest", cell: { x: 14, y: 0 } })]), SHORT_TUNABLES) },
    { name: "c10-traps-stance-tie-and-chain", input: input(battlefield({ traps: [trap("t1", { x: 12, y: 5 }, { damage: 10 }), trap("t2", { x: 16, y: 5 }, { damage: 10 }), trap("t3", { x: 14, y: 9 }, { damage: 10 })] }), party([unit({ ref: "a", stance: "traps", cell: { x: 14, y: 0 } })]), SHORT_TUNABLES) },
    { name: "c10-traps-stance-falls-back-to-post", input: input(battlefield({ posts: [post("p", { x: 14, y: 8 }, { stance: "hold", hp: 300, maxHp: 300 })] }), party([unit({ ref: "a", stance: "traps", cell: { x: 14, y: 0 } })]), SHORT_TUNABLES) },
    { name: "c10-retarget-when-post-dies", input: input(battlefield({ posts: [holdAt("p1", { x: 14, y: 6 }, { hp: 60, maxHp: 1100 }), holdAt("p2", { x: 19, y: 9 }, { hp: 60, maxHp: 1100 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: 3000 })]), SHORT_TUNABLES) },
    { name: "c10-fast-mover-no-tunnelling", input: input(battlefield({ traps: [trap("t", { x: 14, y: 5 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, moveSpeed: 65536 })]), SHORT_TUNABLES) },
    { name: "c10-sealed-ring-dashers", input: input(battlefield({ fences: ringExcept([], 300) }), party([unit({ ref: "a", cell: { x: 14, y: 0 } }), unit({ ref: "b", edge: "west", cell: { x: 0, y: 15 } }), unit({ ref: "c", edge: "south", cell: { x: 20, y: 31 } })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0) }) },
    // ── chunk 11: damage, traps, posted stances, siege ──
    { name: "c11-hold-reach-in", input: input(battlefield({ posts: [holdAt("p", { x: 13, y: 8 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 5000 })]), SHORT_TUNABLES) },
    { name: "c11-hold-reach-out", input: input(battlefield({ posts: [holdAt("p", { x: 12, y: 8 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 5000 })]), SHORT_TUNABLES) },
    { name: "c11-mutual-kill-wipes-both-sides", input: input(battlefield({ posts: [holdAt("p", { x: 14, y: 8 }, { hp: 57, maxHp: 1100 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: 40 })]), SHORT_TUNABLES) },
    { name: "c11-trap-tie-two-units", input: input(battlefield({ traps: [trap("t", { x: 14, y: 5 })] }), party([unit({ ref: "b", cell: { x: 14, y: 0 } }), unit({ ref: "a", cell: { x: 14, y: 0 } })]), SHORT_TUNABLES) },
    { name: "c11-one-unit-two-traps-one-tick", input: input(battlefield({ traps: [trap("t2", { x: 14, y: 6 }), trap("t1", { x: 14, y: 5 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, moveSpeed: 65536 })]), SHORT_TUNABLES) },
    { name: "c11-trap-kills-last-raider", input: input(battlefield({ traps: [trap("t", { x: 14, y: 5 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 100 })]), SHORT_TUNABLES) },
    { name: "c11-root-trap", input: input(battlefield({ traps: [trap("t", { x: 14, y: 5 }, { effect: ROOT })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 } })]), SHORT_TUNABLES) },
    { name: "c11-slow-trap", input: input(battlefield({ traps: [trap("t", { x: 14, y: 5 }, { effect: SLOW })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 } })]), SHORT_TUNABLES) },
    { name: "c11-effect-refresh-not-stack", input: input(battlefield({ traps: [trap("t1", { x: 14, y: 5 }, { effect: ROOT, damage: 1 }), trap("t2", { x: 14, y: 7 }, { effect: ROOT, damage: 1 }), trap("t3", { x: 14, y: 9 }, { effect: SLOW, damage: 1 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, moveSpeed: 4096 })]), SHORT_TUNABLES) },
    { name: "c11-root-at-40-ticks-per-second", input: input(battlefield({ traps: [trap("t", { x: 14, y: 5 }, { effect: ROOT })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 } })]), { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 10, tickRate: 40 }) },
    { name: "c11-guard-aggro-beyond-leash", input: input(battlefield({ posts: [post("q", { x: 14, y: 8 }, { aggroRadius: fx(6144) })] }), party([unit({ ref: "a", attackRange: 0, cell: { x: 14, y: 0 }, hp: 5000 })]), SHORT_TUNABLES) },
    { name: "c11-two-guards-one-target", input: input(battlefield({ posts: [post("p1", { x: 13, y: 8 }), post("p2", { x: 14, y: 8 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 3000 })]), SHORT_TUNABLES) },
    { name: "c11-guard-no-route-sealed-stalemate", input: input(battlefield({ fences: ringExcept([], BIG), posts: [post("p", { x: 14, y: 12 }, { aggroRadius: fx(8192), attackRange: fx(4096) })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 100_000 })]), SHORT_TUNABLES) },
    { name: "c11-guard-kills-raider-held", input: input(battlefield({ posts: [post("p", { x: 14, y: 8 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: 40 })]), SHORT_TUNABLES) },
    { name: "c11-reserve-released-inside-ring", input: input(battlefield({ fences: ringExcept([15]), posts: [post("p", { x: 17, y: 17 }, { stance: "reserve" })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 5000 })]), SHORT_TUNABLES) },
    { name: "c11-stance-guard", input: stanceFight("guard") },
    { name: "c11-stance-hold", input: stanceFight("hold") },
    { name: "c11-stance-reserve", input: stanceFight("reserve") },
    { name: "c11-siege-matched-timber", input: input(battlefield({ fences: ringExcept([], 300) }), party([unit({ ref: "a", cell: { x: 14, y: 0 } })], [timber()]), QUIET_SHORT_TUNABLES) },
    { name: "c11-siege-mismatched-fence", input: input(battlefield({ fences: ringExcept([], 300) }), party([unit({ ref: "a", cell: { x: 14, y: 0 } })], [stone()]), QUIET_SHORT_TUNABLES) },
    { name: "c11-siege-matched-trap", input: input(battlefield({ traps: [trap("t", { x: 14, y: 5 }, { effect: ROOT })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 } })], [planks()]), SHORT_TUNABLES) },
    { name: "c11-siege-mismatched-trap", input: input(battlefield({ traps: [trap("t", { x: 14, y: 5 }, { effect: ROOT })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 } })], [powderSiege()]), SHORT_TUNABLES) },
    { name: "c11-affinity-favourable-wins", input: input(battlefield({ posts: [holdAt("p", { x: 14, y: 8 }, { defense: 100, hp: 1000, maxHp: 1000, affinity: "grit", attackCooldown: ms(1000) })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, affinity: "beast", offense: 90, hp: 900 })]), quiet({ ...SHORT_TUNABLES, battleLengthCapSeconds: 120 })) },
    { name: "c11-affinity-unfavourable-loses", input: input(battlefield({ posts: [holdAt("p", { x: 14, y: 8 }, { defense: 100, hp: 1000, maxHp: 1000, affinity: "grit", attackCooldown: ms(1000) })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, affinity: "powder", offense: 100, hp: 1000 })]), quiet({ ...SHORT_TUNABLES, battleLengthCapSeconds: 120 })) },
    { name: "c11-breacher-answers-ranged-post", input: input(battlefield({ fences: ringExcept([], 100), posts: [holdAt("p", { x: 14, y: 12 }, { hp: 13, maxHp: 40, attackRange: fx(4096) })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, offense: 40, attackRange: 4096 })]), QUIET_SHORT_TUNABLES) },
    // ── chunk 12: the six archetypes at their boundaries ──
    { name: "c12-burst-into-a-cluster", input: input(battlefield({ posts: [holdAt("p1", { x: 13, y: 8 }), holdAt("p2", { x: 14, y: 8 }), holdAt("p3", { x: 14, y: 9 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: 6000, ability: BURST })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(256) }) },
    { name: "c12-post-burst-on-a-pack", input: input(battlefield({ posts: [holdAt("p", { x: 14, y: 8 }, { ability: BURST, hp: 6000, maxHp: 6000 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 13, y: 0 }, hp: 3000 }), unit({ ref: "b", stance: "nearest", cell: { x: 14, y: 0 }, hp: 3000 }), unit({ ref: "c", stance: "nearest", cell: { x: 15, y: 0 }, hp: 3000 })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(256) }) },
    { name: "c12-heavy-strike-both-sides", input: input(battlefield({ posts: [holdAt("p", { x: 14, y: 8 }, { ability: HEAVY, hp: 4000, maxHp: 4000 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: 6000, ability: HEAVY })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(256) }) },
    { name: "c12-heal-ceiling-carried-damage", input: input(battlefield({ posts: [holdAt("h", { x: 14, y: 9 }, { ability: HEAL }), holdAt("w", { x: 14, y: 8 }, { hp: 800, maxHp: 1100 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: 4000, ability: HEAL })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(256) }) },
    { name: "c12-buff-refresh-not-stack", input: input(battlefield({ posts: [holdAt("p", { x: 14, y: 8 }, { hp: 5000, maxHp: 5000, ability: { ...BUFF, cooldown: ms(2000) } as Ability })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: 5000, ability: { ...BUFF, cooldown: ms(2000) } as Ability })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0) }) },
    { name: "c12-guard-dashes-within-leash", input: input(battlefield({ posts: [post("g", { x: 14, y: 8 }, { ability: DASH, aggroRadius: fx(6144), leashDistance: fx(4096), hp: BIG, maxHp: BIG })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: BIG, attackRange: 4096, moveSpeed: 1024 })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0) }) },
    { name: "c12-breaker-room-after-normal-hit", input: input(battlefield({ fences: ringExcept([], 1000).map((x) => ({ ...x, category: "stone" as const })) }), party([unit({ ref: "a", ability: BREAKER, offense: 120 })], [stone()]), { ...SHORT_TUNABLES, structureBreakerFirstUseMult: fx(0) }) },
    { name: "c12-huge-buff-capped-on-fences", input: input(battlefield({ fences: ringExcept([], 300) }), party([unit({ ref: "a", ability: { ...BUFF, damageBonus: fx(63 * 1024), cooldown: ms(1000) } as Ability, offense: 120, mergeLevel: 5 })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0) }) },
    // ── chunk 13: end-condition edges ──
    // An open-field raider whose arrival lands exactly on the cap tick (tick 179 of a 9 s cap): an overrun, not a stalemate.
    { name: "c13-overrun-on-the-cap-tick", input: input(battlefield(), party([unit({ ref: "a", moveSpeed: 1540 })]), { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 9 }) },
    // The last raider dies to a trap on the cap tick (tick 59 of a 3 s cap): held, not a stalemate.
    { name: "c13-wipe-on-the-cap-tick", input: input(battlefield({ traps: [trap("t", { x: 14, y: 5 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 100, moveSpeed: 1340 })]), { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 3 }) },
    // One raider reaches the core on tick 180 while the other — the last one alive — dies to a trap on tick 180: the overrun wins.
    { name: "c13-overrun-and-wipe-same-tick", input: input(battlefield({ traps: [trap("t", { x: 20, y: 3 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 } }), unit({ ref: "b", cell: { x: 20, y: 0 }, hp: 100, moveSpeed: 100 })]), SHORT_TUNABLES) },
    // Both sides alive and swinging when the cap comes: a stalemate (the raiders withdraw).
    { name: "c13-stalemate-both-sides-fighting", input: input(battlefield({ posts: [holdAt("p", { x: 14, y: 8 }, { hp: BIG, maxHp: BIG })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: BIG })]), SHORT_TUNABLES) },
    // A guard whose aggro reaches a raider that stands trading blows with a far hold post: it chases to its
    // leash (the clamped step logged as `amount`), walks home, re-acquires, for all 30 s — a stalemate.
    { name: "c13-stalemate-guard-leash-oscillation", input: input(battlefield({ posts: [holdAt("h", { x: 14, y: 4 }, { hp: BIG, maxHp: BIG }), post("g", { x: 14, y: 12 }, { aggroRadius: fx(10240), leashDistance: fx(4096), hp: BIG, maxHp: BIG })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 14, y: 0 }, hp: BIG, attackRange: 1024 })]), SHORT_TUNABLES) },
    // Raiders chipping a sealed 1 000 000-HP ring all fight: at the fence but never inside the ring line — a stalemate, depth 0 (v8, QA-13 D1).
    { name: "c13-stalemate-deep-but-not-in", input: input(battlefield({ fences: ringExcept([], BIG) }), party([unit({ ref: "a", cell: { x: 14, y: 0 } }), unit({ ref: "b", edge: "east", cell: { x: 31, y: 15 }, stance: "nearest" })]), SHORT_TUNABLES) },
    // The log-budget worst case: the full-load roster, unkillable, fighting at full intensity for the whole 180 s.
    { name: "c13-full-load-full-length", input: fullLoadFullLength() },
  ];
}

/**
 * The full-load roster (16 raiders, 8 posts, 16 segments, 6 traps, 2 siege) with every raider
 * and post made unkillable (1 000 000 HP) and every raider on the `nearest` stance: they
 * break in and then trade blows with the posts for every one of the 3600 ticks — the most
 * events a full-load fight can log, the worst case for the replay's size (chunk 13
 * LOG_SIZE_BUDGET), measured in budget.test.ts. A stalemate.
 */
export function fullLoadFullLength(): ResolveInput {
  const base = fullLoadScenario();
  const BIG = 1_000_000;
  return {
    ...base,
    battlefield: { ...base.battlefield, posts: base.battlefield.posts.map((p) => ({ ...p, hp: BIG, maxHp: BIG })) },
    party: { ...base.party, units: base.party.units.map((u) => ({ ...u, stance: "nearest" as const, hp: BIG, maxHp: BIG })) },
  };
}
