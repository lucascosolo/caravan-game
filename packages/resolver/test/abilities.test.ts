/**
 * Chunk 12 — unit abilities (phase 7, abilities.ts): six parameterized archetypes on
 * automatic cooldowns. Literal fixtures only (no content import). Most rules are pinned by
 * driving `abilityPhase` directly on a built state so every number is hand-checkable; the
 * end-to-end cases run `resolve`.
 *
 * Hand numbers used throughout (fixtures' defaults): an attacker is beast, offense 95; a post
 * is grit, defense 100. Beast → grit is ADVANTAGE (×1.25), grit → beast DISADVANTAGE (×0.80).
 *   attacker → post: floor(95² / 195) = 46, × 1280/1024 → 57
 *   post → attacker: floor(100² / 195) = 51, × 819/1024 → 40
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ABILITY_ARCHETYPES,
  FIXED_POINT_SCALE,
  INPUT_BOUNDS,
  abilityHitDamage,
  abilityPhase,
  assertResolveInput,
  cellCenter,
  cellOf,
  deathPhase,
  hitDamage,
  initialState,
  isAnchorCell,
  isqrt,
  legOffset,
  normalizeInput,
  pathPhase,
  resolve,
  ringIndexAt,
  scaleInt,
  structureBreakerDamage,
  type Ability,
  type Fixed,
  type LogEvent,
  type ResolveInput,
  type ResolveOutput,
  type SimState,
  type UnitState,
} from "../src/index.js";
import { BREAKER, BUFF, BURST, DASH, DEFAULT_TUNABLES, abilityScenarios, HEAL, HEAVY, SHORT_TUNABLES, battlefield, clone, fence, fx, input, ms, party, post, ringExcept, trap, unit } from "./fixtures.js";

const mk = (inp: ResolveInput): SimState => initialState(normalizeInput(clone(inp)));
const place = (u: UnitState, x: number, y: number): void => {
  u.x = x as Fixed;
  u.y = y as Fixed;
};
/** Run phase 7 alone at `tick`; return the events it logged. */
function phase7(state: SimState, tick: number): LogEvent[] {
  state.tick = tick;
  const log: LogEvent[] = [];
  abilityPhase(state, log);
  return log;
}
type AbilityEvent = Extract<LogEvent, { k: "ability" }>;
const abilities = (log: readonly LogEvent[]): AbilityEvent[] => log.filter((e): e is AbilityEvent => e.k === "ability");
const events = <K extends LogEvent["k"]>(out: ResolveOutput, k: K) => out.log.filter((e): e is Extract<LogEvent, { k: K }> => e.k === k);
const C = (n: number): number => n * FIXED_POINT_SCALE + 512; // a cell centre coordinate
const UR = 358; // unit radius
const BIG = 1_000_000;

/** One attacker and some posts standing in the open, all far from everything else. */
function duel(attacker: Partial<Parameters<typeof unit>[0]>, posts: ReturnType<typeof post>[], tunables = DEFAULT_TUNABLES): SimState {
  return mk(input(battlefield({ posts }), party([unit({ ref: "a", hp: BIG, ...attacker })]), tunables));
}

// ─── structure: six cases, no per-type branching ─────────────────────────────────────────

describe("six parameterized archetypes (DoD 1)", () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  const src = (f: string) => readFileSync(path.join(srcDir, f), "utf8");

  it("abilities.ts switches on exactly the six archetypes and nothing else; no resolver file names a unit type or reads typeId outside the input/state plumbing", () => {
    const cases = [...src("abilities.ts").matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!);
    expect([...new Set(cases)].sort()).toEqual([...ABILITY_ARCHETYPES].sort());
    // Two switches (decide, apply), each over all six.
    for (const a of ABILITY_ARCHETYPES) expect(cases.filter((c) => c === a).length, a).toBe(2);
    for (const f of files) {
      expect(src(f), `${f} names a content unit type`).not.toMatch(/["'`](desert|high_plains|mountain|badlands)\./);
      if (!["state.ts", "resolve.ts", "input.ts", "battlefield.ts"].includes(f)) expect(src(f), `${f} reads typeId`).not.toMatch(/\.typeId\b/);
    }
    // Merge level never steers an ability: abilities.ts does not read it.
    expect(src("abilities.ts")).not.toMatch(/mergeLevel/);
  });

  it("siege has no abilities: a siege piece carrying one is refused at the input boundary", () => {
    const bad = clone(input(battlefield(), party([unit({ ref: "a" })], [{ ref: "s", typeId: "siege.battering_wagon", counters: { kind: "fence", category: "timber" } }]))) as unknown as { party: { siege: Record<string, unknown>[] } };
    bad.party.siege[0]!.ability = BURST;
    expect(() => assertResolveInput(bad)).toThrow(/unknown key 'ability'/);
  });
});

// ─── cooldowns, first use, trigger rule ─────────────────────────────────────────────────

describe("ABILITY_COOLDOWN, ABILITY_FIRST_USE_DELAY, ABILITY_TRIGGER_RULE", () => {
  // A heavy-strike attacker (15 s → 300 ticks) with a post in reach the whole time.
  const ticksFired = (state: SimState, upTo: number, u = 0) => {
    const out: number[] = [];
    for (let t = 0; t <= upTo; t++) for (const e of abilities(phase7(state, t))) if (e.u === u) out.push(t);
    return out;
  };
  const strikeDuel = (mult: number) => {
    const s = duel({ ability: HEAVY }, [post("p", { x: 8, y: 9 }, { hp: BIG, maxHp: BIG })], { ...DEFAULT_TUNABLES, abilityFirstUseDelayMult: fx(mult) });
    place(s.units[0]!, C(8), C(8));
    return s;
  };

  it("cooldown in integer ticks; the first use waits a full cooldown (×1.0), and the delay is the tunable multiplier", () => {
    expect(strikeDuel(1024).units[0]!.abilityCooldownTicks).toBe(300);
    expect(ticksFired(strikeDuel(1024), 1000)).toEqual([300, 600, 900]);
    expect(ticksFired(strikeDuel(0), 700)).toEqual([0, 300, 600]);
    expect(ticksFired(strikeDuel(512), 800)).toEqual([150, 450, 750]);
  });

  it("ready but no target: it waits, already ready, and fires the first tick a target is there; the next cooldown counts from that firing", () => {
    const s = strikeDuel(1024);
    const a = s.units[0]!;
    place(s.units[1]!, C(20), C(20)); // far out of reach
    const fired: number[] = [];
    for (let t = 0; t <= 1000; t++) {
      if (t === 437) place(s.units[1]!, C(8), C(9)); // comes into reach
      for (const e of abilities(phase7(s, t))) if (e.u === 0) fired.push(e.t);
      if (t === 436) expect(a.abilityReadyTick).toBe(300); // still ready, nothing spent
    }
    expect(fired).toEqual([437, 737]);
  });

  it("an ability whose condition becomes satisfiable during the tick (phase 3 movement) fires that tick; one made satisfiable only by another ability in the same phase 7 waits for the next tick", () => {
    // Mid-tick via movement: the full resolve. A core-stance attacker walks up x = 15 past a
    // hold post at (15,20) carrying a 6 s burst (ready from tick 120). The attacker moves 51
    // per tick from y = C(31); after tick t's movement it is at C(31) − 51 (t + 1), first within
    // 2 + 0.35 cells of the post at t = 173 — and the burst fires on exactly that tick.
    const out = resolve(input(battlefield({ posts: [post("p", { x: 15, y: 20 }, { stance: "hold", ability: { ...BURST, cooldown: ms(6000) } as Ability, hp: BIG, maxHp: BIG })] }), party([unit({ ref: "a", cell: { x: 15, y: 31 }, edge: "south", hp: BIG, moveSpeed: 1024 })]), SHORT_TUNABLES));
    const burst = abilities(out.log).find((e) => e.a === "burst_radius")!;
    const reach = (2048 + UR) * (2048 + UR);
    const y = (t: number) => C(31) - 51 * (t + 1);
    expect(burst.t).toBe(173);
    expect((y(173) - C(20)) ** 2).toBeLessThanOrEqual(reach);
    expect((y(172) - C(20)) ** 2).toBeGreaterThan(reach);

    // Same phase: a dash (id 0) would carry the attacker into the post's burst reach, but the
    // burst decides against the start-of-phase-7 state — it waits one tick.
    const st = duel({ ability: DASH }, [post("p", { x: 8, y: 13 }, { stance: "hold", ability: BURST })]);
    const a = st.units[0]!;
    place(a, C(8), C(8));
    a.waypoints = [{ x: C(8) as Fixed, y: C(14) as Fixed, breach: -1 }];
    a.legLen = -1;
    a.abilityReadyTick = 0;
    st.units[1]!.abilityReadyTick = 0;
    const first = abilities(phase7(st, 0));
    expect(first.map((e) => e.a)).toEqual(["dash"]); // the burst saw the attacker 5 cells away
    expect((a.y - C(13)) ** 2).toBeLessThanOrEqual(reach); // …and now it is in reach
    expect(abilities(phase7(st, 1)).map((e) => e.a)).toEqual(["burst_radius"]);
  });
});

// ─── burst radius ───────────────────────────────────────────────────────────────────────

describe("burst_radius", () => {
  it("hits every living enemy within EXACTLY radius + unitRadius (inclusive), in ascending id, each for ×damageMult of the merged hit", () => {
    const s = duel({ ability: BURST }, [post("p1", { x: 4, y: 4 }), post("p2", { x: 4, y: 4 }), post("p3", { x: 4, y: 4 }), post("p4", { x: 4, y: 4 })]);
    const a = s.units[0]!;
    place(a, C(10), C(10));
    const r = 2048 + UR;
    place(s.units[1]!, C(10) + r, C(10)); // exactly at the radius
    place(s.units[2]!, C(10) + r + 1, C(10)); // one unit beyond
    place(s.units[3]!, C(10), C(10) - 100); // well inside
    place(s.units[4]!, C(10) - 2000, C(10) - 1500); // 2500 away: beyond (2406)
    a.abilityReadyTick = 0;
    const [e] = abilities(phase7(s, 0));
    expect(e).toMatchObject({ u: 0, a: "burst_radius" });
    expect(e!.tg.map((t) => t.id)).toEqual([1, 3]);
    // 57 × 1536/1024 = 85.
    expect(e!.tg.map((t) => t.amount)).toEqual([85, 85]);
    expect(e!.tg[0]!.hp).toBe(1100 - 85);
    expect(abilityHitDamage(s, a, s.units[1]!, fx(1536))).toBe(scaleInt(57, fx(1536)));
  });

  it("no enemy in reach (or only one already at 0 HP): no cast, still ready", () => {
    const s = duel({ ability: BURST }, [post("p", { x: 4, y: 4 })]);
    place(s.units[0]!, C(20), C(20));
    s.units[0]!.abilityReadyTick = 0;
    expect(abilities(phase7(s, 0))).toEqual([]);
    place(s.units[1]!, C(20), C(21));
    s.units[1]!.hp = 0; // killed earlier this tick: dies in phase 8, not a target
    expect(abilities(phase7(s, 1))).toEqual([]);
    expect(s.units[0]!.abilityReadyTick).toBe(0);
  });

  it("two abilities firing on the same tick both resolve, in caster id order, against start-of-phase state; damage floors at 0", () => {
    const s = mk(input(battlefield({ posts: [post("p", { x: 4, y: 4 }, { hp: 100, maxHp: 1100 })] }), party([unit({ ref: "a", ability: BURST }), unit({ ref: "b", ability: HEAVY })])));
    place(s.units[0]!, C(10), C(10));
    place(s.units[1]!, C(10), C(11));
    place(s.units[2]!, C(10), C(12) - 300);
    s.units[0]!.abilityReadyTick = 0;
    s.units[1]!.abilityReadyTick = 0;
    const evs = abilities(phase7(s, 0));
    expect(evs.map((e) => [e.u, e.a])).toEqual([
      [0, "burst_radius"],
      [1, "heavy_strike"],
    ]);
    // 85 (100 → 15), then heavy 57 × 3.5 = 199 → 0, still targeted: it had HP at the start of the phase.
    expect(evs[0]!.tg[0]).toMatchObject({ id: 2, amount: 85, hp: 15 });
    expect(evs[1]!.tg[0]).toMatchObject({ id: 2, amount: 199, hp: 0 });
  });
});

// ─── heavy strike ───────────────────────────────────────────────────────────────────────

describe("heavy_strike", () => {
  it("strikes the nearest enemy in attack reach (exact tie → lowest id) for ×damageMult of the merged hit — ×3.5 of 57 = 199; at merge level 3, ×3.5 of floor(57 × 1.5625) = 89 → 311", () => {
    const s = duel({ ability: HEAVY }, [post("p1", { x: 4, y: 4 }), post("p2", { x: 4, y: 4 })]);
    const a = s.units[0]!;
    place(a, C(10), C(10));
    place(s.units[1]!, C(10) + 1000, C(10));
    place(s.units[2]!, C(10) - 1000, C(10));
    a.abilityReadyTick = 0;
    const [e] = abilities(phase7(s, 0));
    expect(e!.tg).toEqual([{ kind: "unit", id: 1, amount: 199, hp: 901 }]);
    const s3 = duel({ ability: HEAVY, mergeLevel: 3 }, [post("p1", { x: 4, y: 4 })]);
    place(s3.units[0]!, C(10), C(10));
    place(s3.units[1]!, C(10), C(11));
    s3.units[0]!.abilityReadyTick = 0;
    expect(abilities(phase7(s3, 0))[0]!.tg[0]!.amount).toBe(311);
  });

  it("works for posted units, scored on the DEFENSE rating: 40 × 3.5 = 140 on the attacker", () => {
    const s = duel({}, [post("p", { x: 4, y: 4 }, { ability: HEAVY })]);
    place(s.units[0]!, C(10), C(10));
    place(s.units[1]!, C(10), C(11));
    s.units[0]!.abilityReadyTick = 99; // the attacker's dash stays out of it
    s.units[1]!.abilityReadyTick = 0;
    const [e] = abilities(phase7(s, 0));
    expect(e).toMatchObject({ u: 1, a: "heavy_strike" });
    expect(e!.tg[0]).toMatchObject({ id: 0, amount: 140 });
    expect(hitDamage(s, s.units[1]!, s.units[0]!)).toBe(40);
  });

  it("an ability fires on the tick its caster dies: a caster at 0 HP (still alive until phase 8) strikes, then dies", () => {
    const s = duel({ ability: HEAVY }, [post("p", { x: 4, y: 4 })]);
    place(s.units[0]!, C(10), C(10));
    place(s.units[1]!, C(10), C(11));
    s.units[0]!.hp = 0;
    s.units[0]!.abilityReadyTick = 0;
    const log = phase7(s, 0);
    expect(abilities(log)).toHaveLength(1);
    deathPhase(s, log);
    expect(s.units[0]!.alive).toBe(false);
    expect(s.units[1]!.hp).toBe(1100 - 199);
  });
});

// ─── heal radius ────────────────────────────────────────────────────────────────────────

describe("heal_radius", () => {
  /** A healer post (id 1) and three ally posts (ids 2–4) around (10,10); the attacker (id 0) is far away. */
  function healers(allies: { hp: number; maxHp?: number }[], healer: Partial<ReturnType<typeof post>> = {}) {
    const posts = [post("h", { x: 10, y: 10 }, { ability: HEAL, ...healer }), ...allies.map((a, i) => post(`p${i}`, { x: 10, y: 11 + i }, { hp: a.hp, maxHp: a.maxHp ?? 1100 }))];
    const s = duel({}, posts);
    place(s.units[0]!, C(30), C(30));
    s.units[0]!.abilityReadyTick = BIG;
    for (let i = 0; i < allies.length; i++) place(s.units[2 + i]!, C(10), C(10) + 1000 * (i + 1));
    s.units[1]!.abilityReadyTick = 0;
    return s;
  }

  it("restores floor(maxHp × healFraction) to every wounded ally within radius + unitRadius (caster included), ascending id; never above the HP it entered the battle with, so never above max", () => {
    const s = healers([{ hp: 800 }, { hp: 800 }, { hp: 800 }], { hp: 1000, maxHp: 1100 });
    // Allies 2 and 3 are 1.0 and 2.0 cells away (reach 2.85); ally 4 at 3.0 is out.
    for (const id of [2, 3, 4]) s.units[id]!.hp = 500; // hurt this battle
    s.units[1]!.hp = 900; // the healer itself, hurt this battle (entered at 1000)
    const [e] = abilities(phase7(s, 0));
    expect(e).toMatchObject({ u: 1, a: "heal_radius", charges: 3 });
    // 10.0 % (102/1024) of 1100 = 109. The healer had 100 of room (900 → 1000, its start HP), the allies 300.
    expect(e!.tg).toEqual([
      { kind: "unit", id: 1, amount: 100, hp: 1000 },
      { kind: "unit", id: 2, amount: 109, hp: 609 },
      { kind: "unit", id: 3, amount: 109, hp: 609 },
    ]);
  });

  it("HEAL_CEILING: carried-forward damage is never healed — an ally that entered at 800 / 1100 is not a target until it drops below 800, and is never raised above 800", () => {
    const s = healers([{ hp: 800 }]);
    expect(abilities(phase7(s, 0))).toEqual([]); // nothing to heal: waits, ready
    s.units[2]!.hp = 750;
    const [e] = abilities(phase7(s, 1));
    expect(e!.tg).toEqual([{ kind: "unit", id: 2, amount: 50, hp: 800 }]);
  });

  it("charges are finite and do not regenerate: exactly 4 casts in a battle however long, then never again", () => {
    const s = healers([{ hp: 1100 }]);
    const casts: AbilityEvent[] = [];
    for (let t = 0; t < 3600; t++) {
      s.units[2]!.hp = 300; // wounded again and again
      casts.push(...abilities(phase7(s, t)));
    }
    expect(casts.map((c) => c.t)).toEqual([0, 280, 560, 840]);
    expect(casts.map((c) => (c.a === "heal_radius" ? c.charges : -9))).toEqual([3, 2, 1, 0]);
    expect(s.units[1]!.abilityCharges).toBe(0);
  });

  it("charges reset per encounter (fresh state per resolve), never accumulate: two battles in a row each start with exactly 4", () => {
    const inp = input(battlefield({ posts: [post("h", { x: 15, y: 9 }, { ability: HEAL, stance: "hold" }), post("t", { x: 15, y: 10 }, { stance: "hold", hp: 5000, maxHp: 5000 })] }), party([unit({ ref: "a", stance: "nearest", hp: 50_000, offense: 60 })]));
    const first = resolve(clone(inp));
    const heals1 = abilities(first.log).filter((e) => e.a === "heal_radius");
    expect(heals1.length).toBe(4);
    // Encounter 2: HP carried forward exactly, a fresh satchel.
    const carried = clone(inp) as unknown as { battlefield: { posts: { hp: number }[] } };
    carried.battlefield.posts.forEach((p, i) => (p.hp = Math.max(1, first.units[1 + i]!.hp)));
    expect(initialState(normalizeInput(carried as unknown as ResolveInput)).units[1]!.abilityCharges).toBe(4);
    const second = resolve(carried);
    expect(abilities(second.log).filter((e) => e.a === "heal_radius").length).toBeLessThanOrEqual(4);
  });

  it("no revival: a dead ally is never a target, and an ally at 0 HP (dying this tick) is not one either", () => {
    const s = healers([{ hp: 1100 }, { hp: 1100 }]);
    s.units[2]!.hp = 0;
    s.units[2]!.alive = false; // died earlier
    s.units[3]!.hp = 0; // dying this tick
    expect(abilities(phase7(s, 0))).toEqual([]);
  });
});

// ─── heal vs damage on the same tick ────────────────────────────────────────────────────

describe("HEAL_VS_DAMAGE_SAME_TICK: a heal never saves a unit from damage landing the same tick, whatever the ids", () => {
  it("attacker healer (id 0, would resolve first by id) vs a post's lethal heavy strike (id 2): the ally dies", () => {
    const s = mk(input(battlefield({ posts: [post("p", { x: 4, y: 4 }, { ability: HEAVY })] }), party([unit({ ref: "a", ability: HEAL, hp: 1000 }), unit({ ref: "b", hp: 1000 })])));
    place(s.units[0]!, C(10), C(9));
    place(s.units[1]!, C(10), C(10));
    place(s.units[2]!, C(10), C(11));
    s.units[1]!.hp = 100; // hurt this fight; the post's strike (40 × 3.5 = 140) is lethal
    s.units[0]!.abilityReadyTick = 0;
    s.units[2]!.abilityReadyTick = 0;
    const log = phase7(s, 0);
    const evs = abilities(log);
    // The heal was decided against the start of the phase (the ally had 100 HP), but its only
    // target is at 0 HP by step (b): ABILITY_SKIP_VOID (QA-12 N2) — it is not logged, spends no
    // charge and no cooldown, and stays ready.
    expect(evs.map((e) => [e.u, e.a])).toEqual([[2, "heavy_strike"]]);
    expect(evs[0]!.tg).toEqual([{ kind: "unit", id: 1, amount: 140, hp: 0 }]);
    expect(s.units[0]!.abilityCharges).toBe(4);
    expect(s.units[0]!.abilityReadyTick).toBe(0);
    deathPhase(s, log);
    expect(s.units[1]!.alive).toBe(false);
  });

  it("ABILITY_SKIP_VOID (QA-12 N2): a heal with one target still alive after step (a) fires and spends its charge; the dead target gets 0", () => {
    const s = mk(input(battlefield({ posts: [post("p", { x: 4, y: 4 }, { ability: HEAVY })] }), party([unit({ ref: "a", ability: HEAL, hp: 1000 }), unit({ ref: "b", hp: 1000 })])));
    place(s.units[0]!, C(10), C(9));
    place(s.units[1]!, C(10), C(10));
    place(s.units[2]!, C(10), C(11));
    s.units[0]!.hp = 900; // the healer itself is wounded and survives
    s.units[1]!.hp = 100;
    s.units[0]!.abilityReadyTick = 0;
    s.units[2]!.abilityReadyTick = 0;
    const evs = abilities(phase7(s, 0));
    expect(evs.map((e) => [e.u, e.a])).toEqual([
      [2, "heavy_strike"],
      [0, "heal_radius"],
    ]);
    expect(evs[1]!.tg).toEqual([
      { kind: "unit", id: 0, amount: 99, hp: 999 }, // floor(1000 × 102/1024)
      { kind: "unit", id: 1, amount: 0, hp: 0 },
    ]);
    expect(s.units[0]!.abilityCharges).toBe(3);
    expect(s.units[0]!.abilityReadyTick).toBe(s.units[0]!.abilityCooldownTicks);
  });

  it("mirrored — post healer, attacker burst: the ally post dies too; and lethal damage from phase 6 is never healed", () => {
    const s = mk(input(battlefield({ posts: [post("h", { x: 4, y: 4 }, { ability: HEAL }), post("p", { x: 4, y: 4 }, { hp: 50, maxHp: 1100 })] }), party([unit({ ref: "a", ability: BURST })])));
    place(s.units[0]!, C(10), C(10));
    place(s.units[1]!, C(10), C(13)); // healer out of the burst
    place(s.units[2]!, C(10), C(11));
    s.units[2]!.hp = 40; // entered at 50; burst 85 is lethal
    s.units[0]!.abilityReadyTick = 0;
    s.units[1]!.abilityReadyTick = 0;
    const evs = abilities(phase7(s, 0));
    // The heal's only target died in step (a): skipped (ABILITY_SKIP_VOID), still ready, charge kept.
    expect(evs.map((e) => e.a)).toEqual(["burst_radius"]);
    expect(s.units[2]!.hp).toBe(0);
    expect(s.units[1]!.abilityCharges).toBe(4);
    expect(s.units[1]!.abilityReadyTick).toBe(0);
    // Non-lethal: the heal applies to the HP left after the tick's damage, capped at the start HP.
    const t = mk(input(battlefield({ posts: [post("h", { x: 4, y: 4 }, { ability: HEAL }), post("p", { x: 4, y: 4 })] }), party([unit({ ref: "a", ability: BURST })])));
    place(t.units[0]!, C(10), C(10));
    place(t.units[1]!, C(10), C(13));
    place(t.units[2]!, C(10), C(11));
    t.units[2]!.hp = 1000;
    t.units[0]!.abilityReadyTick = 0;
    t.units[1]!.abilityReadyTick = 0;
    phase7(t, 0);
    expect(t.units[2]!.hp).toBe(1000 - 85 + 109);
  });
});

// ─── self buff ──────────────────────────────────────────────────────────────────────────

describe("self_buff", () => {
  it("fires only with something to hit; the caster's hits carry ×(1 + bonus) for exactly durationTicks after the cast tick", () => {
    const s = duel({ ability: BUFF }, [post("p", { x: 4, y: 4 })]);
    const a = s.units[0]!;
    place(a, C(10), C(10));
    a.abilityReadyTick = 0;
    expect(abilities(phase7(s, 0))).toEqual([]); // nothing in reach
    place(s.units[1]!, C(10), C(11));
    const [e] = abilities(phase7(s, 5));
    expect(e).toMatchObject({ a: "self_buff", until: 105, tg: [{ kind: "unit", id: 0, amount: 100 }] });
    s.tick = 5;
    expect(hitDamage(s, a, s.units[1]!)).toBe(57); // the cast tick's phase 6 is over: unbuffed
    s.tick = 6;
    expect(hitDamage(s, a, s.units[1]!)).toBe(scaleInt(57, fx(1331))); // 74
    s.tick = 105;
    expect(hitDamage(s, a, s.units[1]!)).toBe(74);
    s.tick = 106;
    expect(hitDamage(s, a, s.units[1]!)).toBe(57);
  });

  it("SELF_BUFF_REFRESH: non-stacking — a recast while in force resets the end to one full duration from the recast, never adds or multiplies", () => {
    const fast: Ability = { ...BUFF, cooldown: ms(2000) } as Ability; // 40 ticks < 100-tick duration
    const s = duel({ ability: fast }, [post("p", { x: 4, y: 4 })]);
    place(s.units[0]!, C(10), C(10));
    place(s.units[1]!, C(10), C(11));
    const until: number[] = [];
    for (let t = 0; t <= 80; t++) for (const e of abilities(phase7(s, t))) if (e.a === "self_buff") until.push(e.until);
    expect(until).toEqual([140, 180]);
    s.tick = 81;
    expect(hitDamage(s, s.units[0]!, s.units[1]!)).toBe(74); // ×1.3 once, not ×1.69
  });
});

// ─── dash ───────────────────────────────────────────────────────────────────────────────

describe("dash", () => {
  it("is a movement leg: on a straight route the position at every tick is start + legOffset(d, speed × (t+1) + distance × dashes so far, len), and the event's (x, y) is where the unit stands", () => {
    // 1.0 cell/s = 51 per tick, so the 16 190-long leg is still running when the dashes land.
    const out = resolve(input(battlefield(), party([unit({ ref: "a", cell: { x: 10, y: 0 }, moveSpeed: 1024 })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50) }));
    const dashes = abilities(out.log).filter((e): e is Extract<AbilityEvent, { a: "dash" }> => e.a === "dash");
    expect(dashes[0]!.t).toBe(180);
    expect(dashes[0]!.tg[0]!.amount).toBe(3584);
    const start = cellCenter({ x: 10, y: 0 });
    const end = cellCenter({ x: 15, y: 15 });
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = isqrt(dx * dx + dy * dy);
    let checked = 0;
    for (const k of out.log) {
      if (k.k !== "keyframe") continue;
      const dashed = dashes.filter((d) => d.t <= k.t).reduce((n, d) => n + d.tg[0]!.amount, 0);
      const progress = 51 * (k.t + 1) + dashed;
      if (progress >= len) break;
      expect([k.units[0]!.x, k.units[0]!.y], `tick ${k.t}`).toEqual([start.x + legOffset(dx, progress, len), start.y + legOffset(dy, progress, len)]);
      const d = dashes.find((x) => x.t === k.t);
      if (d) expect([d.x, d.y]).toEqual([k.units[0]!.x, k.units[0]!.y]);
      checked++;
    }
    expect(checked).toBeGreaterThan(180);
  });

  it("never passes through an intact fence: a dash that would cross a breach segment stops on the adjacent cell; a unit standing at an intact segment does not dash at all", () => {
    // Sealed 300-HP ring: the unit walks down x = 15 to (15,10), next to segment 3 at (15,11).
    const s = mk(input(battlefield({ fences: ringExcept([], 300) }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0) }));
    const a = s.units[0]!;
    // Plan as phase 2 would, from (15,8): the route's breach waypoint is the fence cell.
    s.tick = 0;
    const log: LogEvent[] = [];
    place(a, C(15), C(8));
    a.target = { kind: "core" };
    a.pathDirty = true;
    // Run phases 1–2 through the public tick pieces.
    pathPhase(s, log);
    expect(a.waypoints.some((w) => w.breach >= 0)).toBe(true);
    const [e] = abilities(phase7(s, 0));
    expect(e!.a).toBe("dash");
    // 3.5 cells would carry it to y ≈ 11.5 — inside the segment's cell. It stops on (15,10)'s centre.
    expect(cellOf({ x: a.x, y: a.y })).toEqual({ x: 15, y: 10 });
    expect(e!.tg[0]!.amount).toBe(2 * 1024);
    expect(a.breaching).toBeGreaterThanOrEqual(0);
    // Now standing at the intact segment: ready again, but no dash.
    a.abilityReadyTick = 1;
    expect(abilities(phase7(s, 1))).toEqual([]);
  });

  it("over a whole sealed-ring fight with dashing raiders, no unit ever stands in an intact fence or anchor cell", () => {
    const out = resolve(input(battlefield({ fences: ringExcept([], 300) }), party([unit({ ref: "a" }), unit({ ref: "b", cell: { x: 0, y: 15 }, edge: "west" }), unit({ ref: "c", cell: { x: 31, y: 20 }, edge: "east", moveSpeed: 2600 })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50), abilityFirstUseDelayMult: fx(256) }));
    expect(abilities(out.log).filter((e) => e.a === "dash").length).toBeGreaterThanOrEqual(3);
    const intactAt: boolean[] = out.fences.map(() => true);
    for (const e of out.log) {
      if (e.k === "fence_broken") intactAt[e.f] = false;
      if (e.k !== "keyframe") continue;
      for (const u of e.units) {
        const c = cellOf({ x: u.x as Fixed, y: u.y as Fixed });
        const seg = ringIndexAt(c);
        const f = seg === null ? -1 : out.fences.findIndex((g) => g.segment === seg);
        if (f >= 0) expect(intactAt[f], `t ${e.t} unit ${u.u} inside intact segment ${f}`).toBe(false);
        expect(isAnchorCell(c), `t ${e.t} unit ${u.u} inside an anchor`).toBe(false);
      }
    }
  });

  it("DASH_SPRINGS_TRAPS (QA-12 B1): a dash that carries an attacker over a trap springs it in phase 7 of the dash tick, right after the dash — a dash cannot tunnel", () => {
    // Down x = 15 at 76/tick; first dash at floor(180 × 341/1024) = 59: y 5072 → 8656, over the trap at (15,6) (centre 6656, reach 1126).
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 6 })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(341) }));
    const dash = abilities(out.log).find((e) => e.a === "dash")!;
    expect(dash.t).toBe(59);
    expect(events(out, "trap_fired").map((e) => [e.t, e.i, e.u])).toEqual([[59, 0, 0]]);
    // Logged straight after the dash event, in the same tick.
    const i = out.log.findIndex((e) => e.k === "ability" && e.a === "dash");
    expect(out.log[i + 1]).toMatchObject({ t: 59, k: "trap_fired", i: 0, u: 0 });
  });

  it("a posted guard dashes only while pursuing, never past its leash", () => {
    const out = resolve(input(battlefield({ posts: [post("g", { x: 15, y: 8 }, { ability: DASH, aggroRadius: fx(6144), leashDistance: fx(4096), hp: BIG, maxHp: BIG })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, hp: BIG, attackRange: fx(4096), moveSpeed: 1024 })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50), abilityFirstUseDelayMult: fx(0) }));
    const postDashes = abilities(out.log).filter((e) => e.u === 1 && e.a === "dash");
    expect(postDashes.length).toBeGreaterThan(0);
    const home = cellCenter({ x: 15, y: 8 });
    for (const e of out.log) if (e.k === "keyframe") expect((e.units[1]!.x - home.x) ** 2 + (e.units[1]!.y - home.y) ** 2).toBeLessThanOrEqual(4096 * 4096);
  });
});

// ─── structure breaker ──────────────────────────────────────────────────────────────────

describe("structure_breaker", () => {
  const breakerState = (maxHp: number, siege: boolean, mergeLevel = 1) =>
    mk(input(battlefield({ fences: [fence({ segment: 3, maxHp, category: "timber" })] }), party([unit({ ref: "a", ability: BREAKER, mergeLevel })], siege ? [{ ref: "s", typeId: "siege.battering_wagon", counters: { kind: "fence", category: "timber" } }] : [])));

  it("SIEGE_ADDITIVE: ×5 alone = 475; with the countering siege the bonuses add — ×(5 + 4 − 1) = ×8 → 760, never ×20 (1900)", () => {
    expect(structureBreakerDamage(breakerState(2000, false), breakerState(2000, false).units[0]!, 0, fx(5120))).toBe(475);
    const s = breakerState(2000, true);
    expect(structureBreakerDamage(s, s.units[0]!, 0, fx(5120))).toBe(760);
  });

  it("FENCE_HIT_SEGMENT_CAP (QA-12 D1): a breaker hit, like every fence hit, takes at most half the segment's MAX HP per tick — the worst case (offense 120 × level 5 × (5.5 + 4 − 1)) on a 1000-HP segment is 500", () => {
    const s = mk(input(battlefield({ fences: [fence({ segment: 3, maxHp: 1000, category: "stone" })] }), party([unit({ ref: "a", ability: BREAKER, mergeLevel: 5, offense: 120 })], [{ ref: "s", typeId: "siege.blasting_crate", counters: { kind: "fence", category: "stone" } }])));
    // Uncapped: floor(120 × 2500/1024) = 292, × (5632 + 4096 − 1024)/1024 = floor(292 × 8.5) = 2482.
    expect(structureBreakerDamage(s, s.units[0]!, 0, fx(5632))).toBe(500);
    // The cap is of MAX HP, at least 1: a segment already at or below half can be finished by one blow.
    for (const maxHp of [1, 2, 3, 300, 400, 650, 1000, 1_000_000]) {
      const t = mk(input(battlefield({ fences: [fence({ segment: 3, maxHp })] }), party([unit({ ref: "a", ability: BREAKER, mergeLevel: 5, offense: 1_000_000 })], [{ ref: "s", typeId: "x", counters: { kind: "fence", category: "timber" } }])));
      const d = structureBreakerDamage(t, t.units[0]!, 0, fx(64 * 1024));
      expect(d, `maxHp ${maxHp}`).toBe(Math.max(1, Math.floor(maxHp / 2)));
      if (maxHp > 1) expect(d).toBeLessThan(maxHp);
    }
  });

  it("fires when breaching (after phase 6's hit, on the same segment), logs the fence and its HP; never fires for a posted unit (posts never hit fences)", () => {
    const out = resolve(input(battlefield({ fences: ringExcept([], 3000), posts: [post("p", { x: 15, y: 13 }, { ability: BREAKER, stance: "hold" })] }), party([unit({ ref: "a", ability: BREAKER, cell: { x: 15, y: 0 } })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0) }));
    const casts = abilities(out.log).filter((e) => e.a === "structure_breaker");
    expect(casts.length).toBeGreaterThan(0);
    expect(casts.every((c) => c.u === 0)).toBe(true);
    const first = casts[0]!;
    const hit = events(out, "fence_hit").find((h) => h.t === first.t)!;
    expect(first.tg).toEqual([{ kind: "fence", id: hit.f, amount: 475, hp: hit.hp - 475 }]);
  });
});

// ─── merge never changes the ability ────────────────────────────────────────────────────

describe("ABILITY_MERGE_SCALING: merge level raises values only through the merged hit — tested at every level for every archetype", () => {
  const merge = DEFAULT_TUNABLES.mergeStatMultByLevel;
  for (const ability of [BURST, HEAVY, HEAL, BUFF, DASH, BREAKER]) {
    it(`${ability.archetype}: same archetype, cooldown, radius, charges, duration and distance at levels 1–5; damage = the merged hit × the ability's multiplier`, () => {
      const seen: string[] = [];
      for (let level = 1; level <= 5; level++) {
        const s = mk(input(battlefield({ fences: [fence({ segment: 3, maxHp: 100_000 })], posts: [post("p", { x: 4, y: 4 }, { mergeLevel: level, ability, hp: 600, maxHp: 1100 }), post("q", { x: 4, y: 4 })] }), party([unit({ ref: "a", mergeLevel: level, ability, hp: BIG })])));
        const a = s.units[0]!;
        const p = s.units[1]!;
        seen.push(JSON.stringify([a.ability, a.abilityCooldownTicks, a.abilityRadiusSq, a.abilityCharges, a.buffTicks, a.buffMult, a.abilityReadyTick, p.ability, p.abilityCooldownTicks, p.abilityRadiusSq, p.abilityCharges]));
        if (ability.archetype === "burst_radius" || ability.archetype === "heavy_strike") {
          place(a, C(10), C(10));
          place(p, C(30), C(30));
          place(s.units[2]!, C(10), C(11));
          a.abilityReadyTick = 0;
          const [e] = abilities(phase7(s, 0));
          expect(e!.tg[0]!.amount).toBe(scaleInt(scaleInt(57, merge[level]!), ability.damageMult));
        }
        if (ability.archetype === "heal_radius") {
          // The healer's level never matters: 10 % of the TARGET's max HP.
          place(a, C(30), C(30));
          a.abilityReadyTick = BIG;
          place(p, C(10), C(10));
          place(s.units[2]!, C(10), C(11));
          s.units[2]!.hp = 500;
          p.abilityReadyTick = 0;
          const [e] = abilities(phase7(s, 0));
          expect(e!.tg.find((t) => t.id === 2)!.amount).toBe(109);
        }
        if (ability.archetype === "structure_breaker") expect(structureBreakerDamage(s, a, 0, ability.fenceDamageMult)).toBe(scaleInt(scaleInt(95, merge[level]!), ability.fenceDamageMult));
      }
      expect(new Set(seen).size).toBe(1);
    });
  }
});

// ─── input bounds ───────────────────────────────────────────────────────────────────────

describe("ABILITY_FIELD_BOUNDS and the chunk 12 tunables are validated at both ends", () => {
  const withAbility = (a: Record<string, unknown>) => {
    const i = clone(input(battlefield(), party([unit({ ref: "a" })]))) as unknown as { party: { units: Record<string, unknown>[] } };
    i.party.units[0]!.ability = a;
    return i;
  };
  const tunables = (patch: Record<string, unknown>) => ({ ...clone(input(battlefield(), party([unit({ ref: "a" })]))), tunables: { ...DEFAULT_TUNABLES, ...patch } });
  it("refuses each out-of-range ability field and tunable", () => {
    expect(() => assertResolveInput(withAbility({ ...BURST, damageMult: 1023 }))).toThrow(/damageMult/);
    expect(() => assertResolveInput(withAbility({ ...HEAVY, damageMult: INPUT_BOUNDS.maxMult + 1 }))).toThrow(/damageMult/);
    expect(() => assertResolveInput(withAbility({ ...BURST, radius: INPUT_BOUNDS.maxDistance + 1 }))).toThrow(/radius/);
    expect(() => assertResolveInput(withAbility({ ...HEAL, healFraction: 1025 }))).toThrow(/healFraction/);
    expect(() => assertResolveInput(withAbility({ ...HEAL, charges: 1001 }))).toThrow(/charges/);
    expect(() => assertResolveInput(withAbility({ ...BUFF, duration: 0 }))).toThrow(/duration/);
    expect(() => assertResolveInput(withAbility({ ...DASH, distance: INPUT_BOUNDS.maxDistance + 1 }))).toThrow(/distance/);
    expect(() => assertResolveInput(withAbility({ ...BREAKER, fenceDamageMult: 1000 }))).toThrow(/fenceDamageMult/);
    expect(() => assertResolveInput(tunables({ abilityFirstUseDelayMult: INPUT_BOUNDS.maxMult + 1 }))).toThrow(/abilityFirstUseDelayMult/);
    expect(() => assertResolveInput(tunables({ fenceHitSegmentCap: 0 }))).toThrow(/fenceHitSegmentCap must be an integer ≥ 1/);
    expect(() => assertResolveInput(tunables({ fenceHitSegmentCap: 1025 }))).toThrow(/fenceHitSegmentCap must be ≤ 1024/);
    expect(() => assertResolveInput(tunables({ structureBreakerFirstUseMult: -1 }))).toThrow(/structureBreakerFirstUseMult must be an integer ≥ 0/);
    expect(() => assertResolveInput(tunables({ structureBreakerFirstUseMult: INPUT_BOUNDS.maxMult + 1 }))).toThrow(/structureBreakerFirstUseMult must be ≤/);
    // The retired v5 key is refused as an unknown key, not silently ignored.
    expect(() => assertResolveInput(tunables({ structureBreakerSegmentCap: 512 }))).toThrow(/structureBreakerSegmentCap/);
    expect(() => assertResolveInput(tunables({}))).not.toThrow();
  });
});

// ─── the determinism corpus really is ability-heavy ─────────────────────────────────────

describe("the chunk 12 determinism scenarios exercise every archetype", () => {
  it("all six fire, on both sides, a satchel runs dry, a breaker hits with siege, and a heal lands the same tick as a burst", () => {
    const fired: string[] = [];
    let dry = false;
    let sameTick = false;
    for (const { name, input: inp } of abilityScenarios()) {
      const out = resolve(clone(inp));
      const evs = abilities(out.log);
      for (const e of evs) fired.push(`${out.units[e.u]!.side}:${e.a}`);
      if (evs.some((e) => e.a === "heal_radius" && e.charges === 0)) dry = true;
      if (name === "abilities-same-tick-heal-vs-burst") sameTick = evs.some((h) => h.a === "heal_radius" && evs.some((b) => b.a === "burst_radius" && b.t === h.t));
    }
    for (const a of ABILITY_ARCHETYPES) expect(fired, a).toContain(`attacker:${a}`);
    for (const a of ["burst_radius", "heavy_strike", "heal_radius", "self_buff", "dash"]) expect(fired, a).toContain(`defender:${a}`);
    expect(fired).not.toContain("defender:structure_breaker"); // posts never hit fence
    expect(dry, "a satchel runs dry").toBe(true);
    expect(sameTick, "heal and burst on one tick").toBe(true);
  });
});
