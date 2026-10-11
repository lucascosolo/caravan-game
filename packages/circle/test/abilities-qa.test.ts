/**
 * Chunk 12 — the brief's QA probes for abilities, run on REAL content data (every stat, every
 * ability value from @caravan/content) through the real resolver, with the registry's tunables
 * from `resolverTunables()`. Lives in @caravan/circle because the resolver's own tests may not
 * read content (they use literals).
 *
 *   1. Defensive stalemate farming: the worst-case healer turtle against a competent standing
 *      party must NOT reliably survive to the tick cap.
 *   2. Interaction stacking (QA-12 D1, FENCE_HIT_SEGMENT_CAP): no unit — any type, any merge
 *      level, with or without its counter siege, buffed or not, normal hit plus structure
 *      breaker on the same tick — takes more than half a segment's max HP from it in one tick,
 *      on any tier; so every full segment needs at least two blows from one unit. Computed
 *      exhaustively, then confirmed in a fight.
 *   3. Attrition still bites: a caravan carrying healers that survives three consecutive
 *      encounters (HP carried forward exactly) reaches the fourth measurably degraded.
 */
import { describe, expect, it } from "vitest";
import { FENCE_TIERS, LIVING_UNIT_TYPES, TUNABLES, getFenceTier, getTrapType, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
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
  initialState,
  normalizeInput,
  resolve,
  ringSegment,
  structureBreakerDamage,
  type Battlefield,
  type BattlefieldFence,
  type BattlefieldPost,
  type BattlefieldTrap,
  type Cell,
  type EntryEdge,
  type LogEvent,
  type PartySiege,
  type PartyUnit,
  type PostStance,
  type ResolveInput,
  type ResolveOutput,
  type Stance,
  fenceHitDamage,
  landFenceHit,
} from "@caravan/resolver";
import { resolverTunables } from "../src/index.js";

// ─── builders from content ──────────────────────────────────────────────────────────────

function typeOf(typeId: string) {
  const t = getUnitType(typeId);
  if (!t) throw new Error(`unknown unit ${typeId}`);
  return t;
}

function postOf(ref: string, typeId: string, cell: Cell, level: number, stance: PostStance, hp?: number): BattlefieldPost {
  const t = typeOf(typeId);
  const maxHp = scaleInt(t.hp, mergeStatMult(level));
  return {
    ref,
    typeId,
    mergeLevel: level,
    stance,
    cell,
    pos: cellCenter(cell),
    hp: hp ?? maxHp,
    maxHp,
    affinity: t.affinity,
    defense: t.defense,
    moveSpeed: t.moveSpeed,
    attackRange: t.attackRange,
    attackCooldown: t.attackCooldown,
    aggroRadius: t.aggroRadius,
    leashDistance: t.leashDistance,
    ability: t.ability,
  };
}

function raiderOf(ref: string, typeId: string, edge: EntryEdge, cell: Cell, level: number, stance: Stance): PartyUnit {
  const t = typeOf(typeId);
  const maxHp = scaleInt(t.hp, mergeStatMult(level));
  return { ref, typeId, mergeLevel: level, stance, entry: { edge, cell }, hp: maxHp, maxHp, affinity: t.affinity, offense: t.offense, moveSpeed: t.moveSpeed, attackRange: t.attackRange, attackCooldown: t.attackCooldown, ability: t.ability };
}

function fenceOf(segment: number, tierId: string, hp?: number): BattlefieldFence {
  const tier = getFenceTier(tierId)!;
  const seg = ringSegment(segment);
  return { ref: `f${String(segment).padStart(2, "0")}`, segment, cell: seg.cell, pos: cellCenter(seg.cell), tierId, category: tier.category, hp: hp ?? tier.segmentHp, maxHp: tier.segmentHp };
}

function trapOf(ref: string, typeId: string, cell: Cell): BattlefieldTrap {
  const t = getTrapType(typeId)!;
  return { ref, cell, pos: cellCenter(cell), typeId, category: t.category, affinity: t.affinity, damage: t.damage, effect: t.effect };
}

function field(fences: BattlefieldFence[], traps: BattlefieldTrap[], posts: BattlefieldPost[]): Battlefield {
  return {
    v: 2,
    grid: { width: GRID_WIDTH, height: GRID_HEIGHT },
    pathConnectivity: 4,
    core: { cells: CORE_CELLS, center: CORE_CENTER },
    anchors: RING_ANCHORS,
    entries: ENTRY_EDGES.map((edge) => ({ edge, cells: entryBand(edge) })),
    fences,
    traps,
    posts,
  };
}

const SIEGE: Record<string, PartySiege> = {
  stone: { ref: "s-stone", typeId: "siege.blasting_crate", counters: { kind: "fence", category: "stone" } },
  groundwork: { ref: "s-ground", typeId: "siege.bridging_planks", counters: { kind: "trap", category: "groundwork" } },
  powder: { ref: "s-powder", typeId: "siege.dousing_wagon", counters: { kind: "trap", category: "powder" } },
};

const healEvents = (out: ResolveOutput) => out.log.filter((e): e is Extract<LogEvent, { k: "ability"; a: "heal_radius" }> => e.k === "ability" && e.a === "heal_radius");

// ─── 1. the healer turtle ───────────────────────────────────────────────────────────────

/**
 * THE WORST-CASE HEALER TURTLE, built deliberately: every post at merge level 5 (max HP ×2.44),
 * four healers (all four content healers, every one's charges and radius) packed shoulder to
 * shoulder with the four sturdiest defenders (highest defense × HP) on `hold` around the core
 * so every post sits inside at least one healer's radius; the maximum 20 Stacked Stone
 * segments (the toughest tier) with the 8 unavoidable gaps spread two per side; six traps on
 * the approaches. It is built to survive, not to kill.
 */
function turtleCircle(withHealers: boolean, stance: PostStance = "hold"): { fences: BattlefieldFence[]; traps: BattlefieldTrap[]; posts: BattlefieldPost[] } {
  const gaps = [0, 6, 7, 13, 14, 20, 21, 27];
  const fences: BattlefieldFence[] = [];
  for (let s = 0; s < PERIMETER_SEGMENTS; s++) if (!gaps.includes(s)) fences.push(fenceOf(s, "fence.stacked_stone"));
  const tanks = ["mountain.grizzly", "mountain.hardrock_miner", "desert.well_digger", "mountain.pack_mule_train"];
  const healers = ["mountain.apothecary", "desert.canteen_carrier", "high_plains.prairie_doctor", "badlands.snake_oil_peddler"];
  const fill = withHealers ? healers : ["badlands.rail_bull", "high_plains.homesteader", "desert.longhorn_bull", "high_plains.railroad_gang"];
  const tankCells: Cell[] = [
    { x: 15, y: 13 },
    { x: 17, y: 15 },
    { x: 15, y: 17 },
    { x: 13, y: 15 },
  ];
  const healerCells: Cell[] = [
    { x: 13, y: 13 },
    { x: 17, y: 13 },
    { x: 17, y: 17 },
    { x: 13, y: 17 },
  ];
  const posts = [...tanks.map((t, i) => postOf(`p-t${i}`, t, tankCells[i]!, 5, stance)), ...fill.map((t, i) => postOf(`p-h${i}`, t, healerCells[i]!, 5, stance))];
  const traps = [
    trapOf("t0", "trap.spike_pit", { x: 15, y: 9 }),
    trapOf("t1", "trap.jaw_trap", { x: 21, y: 15 }),
    trapOf("t2", "trap.powder_keg", { x: 15, y: 21 }),
    trapOf("t3", "trap.caltrop_scatter", { x: 9, y: 15 }),
    trapOf("t4", "trap.spike_pit", { x: 10, y: 10 }),
    trapOf("t5", "trap.powder_keg", { x: 20, y: 20 }),
  ];
  return { fences, traps, posts };
}

/**
 * A COMPETENT standing party: eight level-5 raiders chosen to answer this circle — stone siege
 * (the circle is all Stacked Stone), a groundwork trap counter, breakers for the stone,
 * ranged and burst damage to out-trade the hold posts, and `nearest` stances so it fights the
 * posts rather than racing the core past them. Variants rotate the entry edges and stance mix:
 * the turtle must not reliably survive ANY reasonable approach, not just one.
 */
function competentParty(variant: number, level = 5): { units: PartyUnit[]; siege: PartySiege[] } {
  const roster = [
    "high_plains.buffalo_bull",
    "mountain.grizzly",
    "badlands.gunslinger",
    "high_plains.buffalo_hunter",
    "desert.sand_sharpshooter",
    "desert.longhorn_bull",
    "badlands.powder_thief",
    "mountain.blasting_crew",
  ];
  const edges: EntryEdge[] = ["north", "east", "south", "west"];
  const units = roster.map((typeId, k) => {
    const edge = edges[(k + variant) % 4]!;
    const along = 8 + ((k * 5 + variant * 3) % 16);
    const cell: Cell = edge === "north" ? { x: along, y: 0 } : edge === "south" ? { x: along, y: GRID_HEIGHT - 1 } : edge === "west" ? { x: 0, y: along } : { x: GRID_WIDTH - 1, y: along };
    const stance: Stance = variant % 2 === 0 ? "nearest" : k % 3 === 0 ? "core" : "nearest";
    return raiderOf(`r${k}`, typeId, edge, cell, level, stance);
  });
  return { units, siege: [SIEGE.stone!, SIEGE.groundwork!, SIEGE.powder!] };
}

function fight(circle: ReturnType<typeof turtleCircle>, p: ReturnType<typeof competentParty>): ResolveOutput {
  const input: ResolveInput = { battlefield: field(circle.fences, circle.traps, circle.posts), party: { v: 1, units: p.units, siege: p.siege }, tunables: resolverTunables() };
  return resolve(JSON.parse(JSON.stringify(input)));
}

/** The caravan survives to the cap only if no raider ever stood on the core and a post is still alive. */
function caravanHeld(out: ResolveOutput): boolean {
  const overrun = out.units.some((u) => u.side === "attacker" && u.reachedCoreTick >= 0);
  const anyPost = out.units.some((u) => u.side === "defender" && u.alive);
  return !overrun && anyPost;
}

describe("chunk 12 QA: defensive stalemate farming — the worst-case healer turtle", () => {
  it("does NOT reliably survive to the tick cap against a competent attack, in either stance", () => {
    const VARIANTS = 8;
    for (const stance of ["hold", "guard"] as const) {
      const lines: string[] = [];
      let held = 0;
      for (let v = 0; v < VARIANTS; v++) {
        const out = fight(turtleCircle(true, stance), competentParty(v));
        if (caravanHeld(out)) held++;
        const firstPost = out.units.findIndex((u) => u.side === "defender");
        const heals = healEvents(out);
        const healed = heals.reduce((n, e) => n + e.tg.reduce((m, t) => m + t.amount, 0), 0);
        const taken = out.log.reduce((n, e) => (e.k === "hit" && e.v >= firstPost ? n + e.damage : n), 0);
        const core = out.units.filter((u) => u.side === "attacker" && u.reachedCoreTick >= 0).map((u) => u.reachedCoreTick);
        lines.push(`approach ${v}: held=${caravanHeld(out)} firstCore=${core.length ? Math.min(...core) : "-"} postsAlive=${out.units.filter((u) => u.side === "defender" && u.alive).length}/8 healCasts=${heals.length} healed=${healed} postDamageTaken=${taken}`);
      }
      process.stdout.write(`${stance} healer turtle (L5) vs 8 L5 raiders + 3 siege: held ${held}/${VARIANTS}\n  ${lines.join("\n  ")}\n`);
      // "Not reliably": at most a quarter of approaches (measured: 0/8 in both stances).
      expect(held, `${stance} turtle`).toBeLessThanOrEqual(Math.floor(VARIANTS / 4));
    }
  });

  it("across weaker attacks (3–8 raiders, merge level 1–5, both stances) healers never make the turtle reliable and never turn more than one loss into a hold", () => {
    const rows: string[] = [];
    for (const [stance, size] of [["hold", 8], ["guard", 8], ["guard", 4], ["guard", 3]] as const) {
      for (let level = 1; level <= 5; level++) {
        let held = 0;
        let heldWithout = 0;
        let healed = 0;
        let taken = 0;
        for (let v = 0; v < 8; v++) {
          const full = competentParty(v, level);
          const party = { units: full.units.slice(0, size), siege: full.siege };
          const out = fight(turtleCircle(true, stance), party);
          const base = fight(turtleCircle(false, stance), party);
          if (caravanHeld(out)) held++;
          if (caravanHeld(base)) heldWithout++;
          const firstPost = out.units.findIndex((u) => u.side === "defender");
          healed += healEvents(out).reduce((n, e) => n + e.tg.reduce((m, t) => m + t.amount, 0), 0);
          taken += out.log.reduce((n, e) => (e.k === "hit" && e.v >= firstPost ? n + e.damage : n), 0);
        }
        rows.push(`${stance} turtle vs ${size} raiders L${level}: held ${held}/8 with healers, ${heldWithout}/8 with tanks instead; healing offset ${((100 * healed) / taken).toFixed(1)}% of post damage`);
        expect(held, rows[rows.length - 1]).toBeLessThanOrEqual(4);
        expect(held - heldWithout, rows[rows.length - 1]).toBeLessThanOrEqual(1);
      }
    }
    process.stdout.write(`healer turtle sweep:\n  ${rows.join("\n  ")}\n`);
  }, 60000);
});

// ─── 2. every fence hit vs every fence tier: one per-unit-per-tick cap ────────────────────

describe("chunk 12 QA D1: interaction stacking — no unit takes more than half a segment in one tick", () => {
  const breakers = LIVING_UNIT_TYPES.filter((t) => t.ability.archetype === "structure_breaker");

  function state(typeId: string, level: number, tierId: string, siege: boolean) {
    const input: ResolveInput = {
      battlefield: field([fenceOf(3, tierId)], [], []),
      party: { v: 1, units: [raiderOf("r", typeId, "north", { x: 15, y: 0 }, level, "core")], siege: siege ? [{ ref: "s", typeId: "siege", counters: { kind: "fence", category: getFenceTier(tierId)!.category } }] : [] },
      tunables: resolverTunables(),
    };
    return initialState(normalizeInput(input));
  }

  it("worst case, computed exhaustively: every type × merge level 1–5 × with/without its counter siege × every fence tier × {normal hit, buffed hit (self buffers), normal + breaker on the same tick (breakers)} ≤ 50 % of the segment per tick", () => {
    expect(TUNABLES.FENCE_HIT_SEGMENT_CAP).toBe(512);
    expect(breakers.length).toBe(6);
    let worst = { ratio: 0, line: "" };
    let worstUncapped = { damage: 0, line: "" };
    let checks = 0;
    for (const t of LIVING_UNIT_TYPES) {
      for (let level = 1; level <= TUNABLES.MERGE_LEVEL_MAX; level++) {
        for (const tier of FENCE_TIERS) {
          const cap = scaleInt(tier.segmentHp, TUNABLES.FENCE_HIT_SEGMENT_CAP);
          for (const siege of [false, true]) {
            const s = state(t.id, level, tier.id, siege);
            const u = s.units[0]!;
            const f = s.fences[0]!;
            const ability = t.ability;
            const variants: string[] = ["normal"];
            if (ability.archetype === "self_buff") variants.push("buffed");
            if (ability.archetype === "structure_breaker") variants.push("normal+breaker");
            for (const v of variants) {
              s.tick = 10;
              u.fenceHitTick = -1;
              u.fenceHitDealt = 0;
              u.buffEndTick = v === "buffed" ? 10 : -1;
              let dealt = fenceHitDamage(s, u, f);
              landFenceHit(s, u, f, dealt);
              if (v === "normal+breaker" && ability.archetype === "structure_breaker") {
                const room = cap - dealt;
                const b = room > 0 ? structureBreakerDamage(s, u, 0, ability.fenceDamageMult) : 0;
                dealt += b;
                // Uncapped, for the record: the reason the cap exists.
                const merged = scaleInt(t.offense, mergeStatMult(level));
                const mult = siege ? ability.fenceDamageMult + TUNABLES.SIEGE_FENCE_DAMAGE_MULT - 1024 : ability.fenceDamageMult;
                const uncapped = scaleInt(merged, siege ? TUNABLES.SIEGE_FENCE_DAMAGE_MULT : (1024 as typeof ability.fenceDamageMult)) + scaleInt(merged, mult as typeof ability.fenceDamageMult);
                if (uncapped > worstUncapped.damage) worstUncapped = { damage: uncapped, line: `${t.id} L${level} ${siege ? "+siege" : ""} vs ${tier.id} (${tier.segmentHp}): normal + breaker uncapped ${uncapped}` };
              }
              const line = `${t.id} L${level} ${siege ? "+siege" : "     "} ${v} vs ${tier.id} (${tier.segmentHp}): ${dealt}`;
              expect(dealt, line).toBeLessThanOrEqual(cap);
              expect(dealt, line).toBeLessThan(tier.segmentHp);
              if (dealt / tier.segmentHp > worst.ratio) worst = { ratio: dealt / tier.segmentHp, line };
              checks++;
            }
          }
        }
      }
    }
    const variantsPerType = LIVING_UNIT_TYPES.length + LIVING_UNIT_TYPES.filter((t) => t.ability.archetype === "self_buff" || t.ability.archetype === "structure_breaker").length;
    expect(checks).toBe(variantsPerType * TUNABLES.MERGE_LEVEL_MAX * FENCE_TIERS.length * 2);
    process.stdout.write(`fence-hit cap worst case: ${worst.line} (${(100 * worst.ratio).toFixed(1)}% of the segment; ${checks} checks)\nworst uncapped normal + breaker: ${worstUncapped.line}\n`);
  });

  it("confirmed in a fight: a level-5 Buffalo Bull with stone siege takes a full Stacked Stone segment in two blows of 500 on two ticks (v5: one normal blow of 1168); at level 1 its breaker takes only the 20 left after a 480 normal hit", () => {
    // A sealed Stacked Stone ring (over the material budget on purpose: the attacker must breach).
    const fences: BattlefieldFence[] = [];
    for (let s = 0; s < PERIMETER_SEGMENTS; s++) fences.push(fenceOf(s, "fence.stacked_stone"));
    const run = (level: number, siege: boolean) =>
      resolve(
        JSON.parse(
          JSON.stringify({
            battlefield: field(fences, [], []),
            party: { v: 1, units: [raiderOf("r", "high_plains.buffalo_bull", "north", { x: 15, y: 0 }, level, "core")], siege: siege ? [SIEGE.stone!] : [] },
            tunables: { ...resolverTunables(), structureBreakerFirstUseMult: 0 },
          }),
        ),
      );
    const casts = (out: ResolveOutput) => out.log.filter((e): e is Extract<LogEvent, { k: "ability" }> & { a: "structure_breaker" } => e.k === "ability" && e.a === "structure_breaker");
    const hits = (out: ResolveOutput) => out.log.filter((e): e is Extract<LogEvent, { k: "fence_hit" }> => e.k === "fence_hit");
    // L1 + stone siege: normal hit 120 × 4 = 480 (1000 → 520); the breaker (120 × (5 + 4 − 1) = 960
    // additively, 2400 if multiplied) gets only the 20 left of the unit's 500 this tick.
    const l1 = run(1, true);
    expect(hits(l1)[0]!.damage).toBe(480);
    expect(casts(l1)[0]!.t).toBe(hits(l1)[0]!.t);
    expect(casts(l1)[0]!.tg[0]).toMatchObject({ kind: "fence", amount: 20, hp: 500 });
    // L5, no siege: normal hit 292 (→ 708); the breaker's 292 × 5 = 1460 is clipped to the 208 left of 500 (→ 500).
    const l5 = run(5, false);
    expect(hits(l5)[0]!.damage).toBe(292);
    expect(casts(l5)[0]!.tg[0]).toMatchObject({ kind: "fence", amount: 208, hp: 500 });
    // L5 + stone siege: the normal hit floor(292 × 4) = 1168 is clipped to 500; the breaker has no
    // room that tick, so it fires on the next and takes the other 500. Two blows, two ticks.
    const l5s = run(5, true);
    expect(hits(l5s)[0]).toMatchObject({ damage: 500, hp: 500 });
    expect(casts(l5s)[0]!.t).toBe(hits(l5s)[0]!.t + 1);
    expect(casts(l5s)[0]!.tg[0]).toMatchObject({ amount: 500, hp: 0 });
  });

  it("D2: with real content and the ×0.25 first use, every breaker fires on a sealed ring of its weakest and strongest tiers", () => {
    const firings: string[] = [];
    for (const t of breakers) {
      for (const tierId of ["fence.brush_pile", "fence.stacked_stone"]) {
        const fences: BattlefieldFence[] = [];
        for (let s = 0; s < PERIMETER_SEGMENTS; s++) fences.push(fenceOf(s, tierId));
        const out = resolve(JSON.parse(JSON.stringify({ battlefield: field(fences, [], []), party: { v: 1, units: [raiderOf("r", t.id, "north", { x: 15, y: 0 }, 1, "core")], siege: [] }, tunables: resolverTunables() })));
        const n = out.log.filter((e) => e.k === "ability" && e.a === "structure_breaker").length;
        firings.push(`${t.id} vs ${tierId}: ${n}`);
        expect(n, `${t.id} vs ${tierId}`).toBeGreaterThan(0);
      }
    }
    process.stdout.write(`breaker firings on a sealed ring (level 1, no siege):\n  ${firings.join("\n  ")}\n`);
  });
});

// ─── 3. attrition still bites ───────────────────────────────────────────────────────────

describe("chunk 12 QA: attrition still bites — release gate", () => {
  /** HP carried forward exactly: survivors keep their HP, the dead are gone, spent traps and broken segments stay so. */
  function carry(circle: ReturnType<typeof turtleCircle>, out: ResolveOutput): ReturnType<typeof turtleCircle> {
    const unit = (ref: string) => out.units.find((u) => u.side === "defender" && u.ref === ref)!;
    return {
      posts: circle.posts.map((p) => ({ ...p, hp: unit(p.ref).hp })).filter((p) => p.hp > 0),
      fences: circle.fences.map((f) => ({ ...f, hp: out.fences.find((g) => g.ref === f.ref)!.hp })).filter((f) => f.hp > 0),
      traps: circle.traps.filter((t) => !out.traps.find((u) => u.ref === t.ref)!.spent),
    };
  }

  // THE STATED FRACTION: after three survived encounters a healer caravan is below 90 % of its
  // full HP. (Measured: 82.6–89.9 % across the four trips below; a healer that could top the
  // caravan up between fights would put it back near 100 %.)
  const DEGRADED_BELOW = 0.9;
  /**
   * Raiders per light encounter. Chunk 37 balance pass (BALANCE-LOG.md): 2 → 3. With defense
   * ratings ×1.5 two level-1 raiders barely scratch the turtle, so there was nothing left for
   * healing to undo and the gate measured nothing; three keeps the encounters light (all survived)
   * but real.
   */
  const LIGHT_RAIDERS = 3;

  /** The same circle with the healers' satchels emptied of effect (healFraction 0): identical units, positions and fights otherwise. */
  function noHealing(circle: ReturnType<typeof turtleCircle>): ReturnType<typeof turtleCircle> {
    return { ...circle, posts: circle.posts.map((p) => (p.ability.archetype === "heal_radius" ? { ...p, ability: { ...p.ability, healFraction: 0 as typeof p.ability.healFraction } } : p)) };
  }

  /** Arrival HP fraction at encounter 4 for one trip, healing on or off. */
  function trip(start: number, healing: boolean): number {
    let circle = healing ? turtleCircle(true, "guard") : noHealing(turtleCircle(true, "guard"));
    const full = circle.posts.reduce((n, p) => n + p.maxHp, 0);
    for (let e = 0; e < 3; e++) {
      const p = competentParty((start + 2 * e) % 8, 1);
      circle = carry(circle, fight(circle, { units: p.units.slice(0, LIGHT_RAIDERS), siege: [] }));
      if (!healing) circle = noHealing(circle);
    }
    return circle.posts.reduce((n, p) => n + p.hp, 0) / full;
  }

  // QA-12 N3: the gate also compares against the SAME caravan with healing switched off, so it
  // cannot pass because nothing happened. Measured (RESOLVER_VERSION 6): with healing 82.6–89.9 %,
  // without 60.3–70.4 %, delta 18.3–22.3 points — healing undoes 56–66 % of the attrition in
  // these light encounters (over the 25–35 % target; full fights 7.5–16 %: a chunk 37 note).
  const HEALING_MUST_ADD = 0.05; // at least 5 points of HP: healing is measurable
  const ATTRITION_KEPT = 0.3; // the healer caravan still loses ≥ 30 % of what it would unhealed (offset ≤ 70 %)

  it("QA-12 N3: healing does real work but does not erase attrition — on every trip the healer caravan arrives ≥ 5 points above the same caravan with healing switched off, and still loses ≥ 30 % of what that caravan loses", () => {
    const lines: string[] = [];
    for (const start of [0, 2, 4, 6]) {
      const healed = trip(start, true);
      const unhealed = trip(start, false);
      lines.push(`trip ${start}: with healing ${(100 * healed).toFixed(1)}%, without ${(100 * unhealed).toFixed(1)}% (delta ${(100 * (healed - unhealed)).toFixed(1)} points)`);
      expect(healed - unhealed, lines[lines.length - 1]).toBeGreaterThan(HEALING_MUST_ADD);
      expect(1 - healed, lines[lines.length - 1]).toBeGreaterThanOrEqual(ATTRITION_KEPT * (1 - unhealed));
      expect(healed, lines[lines.length - 1]).toBeLessThan(DEGRADED_BELOW);
    }
    process.stdout.write(`attrition with vs without healing:\n  ${lines.join("\n  ")}\n`);
  });

  it("a caravan carrying four healers that survives three consecutive encounters reaches the fourth measurably degraded, and no encounter ever ends with more HP than it began", () => {
    const lines: string[] = [];
    for (const start of [0, 2, 4, 6]) {
      let circle = turtleCircle(true, "guard");
      const full = circle.posts.reduce((n, p) => n + p.maxHp, 0);
      const trail: string[] = [];
      for (let e = 0; e < 3; e++) {
        const before = circle.posts.reduce((n, p) => n + p.hp, 0);
        const p = competentParty((start + 2 * e) % 8, 1);
        const out = fight(circle, { units: p.units.slice(0, LIGHT_RAIDERS), siege: [] });
        expect(caravanHeld(out), `trip ${start}, encounter ${e + 1} must be survived for the gate to mean anything`).toBe(true);
        // Charges reset per encounter, never accumulate: each healer casts at most its four.
        for (const healer of out.units.filter((u) => u.side === "defender" && u.typeId.includes("apothecary"))) {
          expect(healEvents(out).filter((h) => h.u === healer.id).length).toBeLessThanOrEqual(TUNABLES.HEAL_CHARGES_PER_BATTLE);
        }
        circle = carry(circle, out);
        const after = circle.posts.reduce((n, p) => n + p.hp, 0);
        expect(after, `trip ${start}, encounter ${e + 1}: healing restored carried-forward damage`).toBeLessThanOrEqual(before);
        trail.push(`${((100 * after) / full).toFixed(1)}%`);
      }
      const left = circle.posts.reduce((n, p) => n + p.hp, 0);
      lines.push(`trip ${start}: ${trail.join(" → ")}, arrives at encounter 4 with ${((100 * left) / full).toFixed(1)}% of full HP`);
      expect(left / full, lines[lines.length - 1]).toBeLessThan(DEGRADED_BELOW);
    }
    process.stdout.write(`attrition (healer guard circle, 3 encounters of 2 raiders):\n  ${lines.join("\n  ")}\n`);
  });
});
