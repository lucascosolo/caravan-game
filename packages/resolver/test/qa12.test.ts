/**
 * Chunk 12 QA round 1 (roadmap/qa/12-punchlist.md) — RESOLVER_VERSION 6. Literal fixtures only.
 *   B1  an attacker's dash springs the traps on its path inside phase 7, before core_reached.
 *   D1  FENCE_HIT_SEGMENT_CAP: one unit takes at most half a segment's max HP per tick, every
 *       fence hit summed (normal, buffed, siege, structure breaker).
 *   D2  STRUCTURE_BREAKER_FIRST_USE_MULT: a breaker's first use is ×0.25 of its cooldown.
 *   S3  merge × buff with one floor.
 *   N1  a caster brought to 0 HP earlier in phase 7 does not dash; N2 a 0-HP caster's self buff
 *       is skipped (a heal whose targets all died is pinned in abilities.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  FIXED_POINT_SCALE,
  INPUT_BOUNDS,
  abilityPhase,
  dealtOutput,
  fenceHitCap,
  fenceHitDamage,
  fenceHitRoom,
  initialState,
  landFenceHit,
  normalizeInput,
  resolve,
  scaleInt2,
  type Ability,
  type Fixed,
  type LogEvent,
  type ResolveInput,
  type ResolveOutput,
  type SimState,
  type UnitState,
} from "../src/index.js";
import { BREAKER, BUFF, BURST, DASH, DEFAULT_TUNABLES, HEAVY, SHORT_TUNABLES, battlefield, clone, fence, fx, input, party, post, qa12DashCoreInput, ringExcept, scenarios, trap, unit } from "./fixtures.js";

const mk = (inp: ResolveInput): SimState => initialState(normalizeInput(clone(inp)));
const C = (n: number): number => n * FIXED_POINT_SCALE + 512;
const place = (u: UnitState, x: number, y: number): void => {
  u.x = x as Fixed;
  u.y = y as Fixed;
};
const events = <K extends LogEvent["k"]>(out: ResolveOutput, k: K) => out.log.filter((e): e is Extract<LogEvent, { k: K }> => e.k === k);
type BreakerCast = Extract<LogEvent, { k: "ability" }> & { a: "structure_breaker" };
const breakerCasts = (out: ResolveOutput): BreakerCast[] => out.log.filter((e): e is BreakerCast => e.k === "ability" && e.a === "structure_breaker");
const breakerWith = (fenceDamageMult: number): Ability => ({ ...(BREAKER as Extract<Ability, { archetype: "structure_breaker" }>), fenceDamageMult: fx(fenceDamageMult) });

// ─── B1 ─────────────────────────────────────────────────────────────────────────────────

describe("QA-12 B1: a dash springs its traps inside phase 7, and core_reached comes only after, only with HP > 0", () => {
  for (const name of ["qa12-dash-over-trap-onto-core", "qa12-dash-over-trap-tick-cap"]) {
    it(`${name}: the trap fires on the dash tick, right after the dash; the unit dies and never reaches the core`, () => {
      const out = resolve(clone(scenarios().find((s) => s.name === name)!.input));
      const dash = out.log.find((e) => e.k === "ability" && e.a === "dash")!;
      const i = out.log.indexOf(dash);
      expect(out.log[i + 1]).toMatchObject({ t: dash.t, k: "trap_fired", u: 0, i: 0, damage: 199, hp: 0 });
      expect(events(out, "core_reached")).toEqual([]);
      expect(out.units[0]!.reachedCoreTick).toBe(-1);
      expect(out.units[0]!.diedTick).toBe(dash.t);
      if (name.endsWith("tick-cap")) expect(dash.t).toBe(out.tickCap - 1);
    });
  }

  it("the reviewer's p6b sweep: for every first-use delay ×0 … ×1.5625 (step 2/1024), no core_reached ever precedes the lethal trap", () => {
    let dashedOverTrap = 0;
    for (let m = 0; m <= 1600; m += 2) {
      const out = resolve(qa12DashCoreInput(m, 30));
      const core = out.log.find((e) => e.k === "core_reached");
      const fired = out.log.find((e) => e.k === "trap_fired");
      if (fired && out.log.some((e) => e.k === "ability" && e.a === "dash" && e.t === fired.t)) dashedOverTrap++;
      if (core && fired) expect(core.t, `×${m}/1024`).toBeGreaterThan(fired.t);
      if (fired && fired.hp === 0) expect(core, `×${m}/1024: a unit the trap killed reached the core`).toBeUndefined();
    }
    expect(dashedOverTrap).toBeGreaterThan(50); // v5: 108 of these delays logged core_reached first
  });

  it("a survivable trap on a dash that ends on the core: dash, then trap_fired, then core_reached, all on the dash tick", () => {
    const inp = qa12DashCoreInput(1138, 30);
    (inp.battlefield.traps[0] as { damage: number }).damage = 10;
    const out = resolve(inp);
    const dash = out.log.find((e) => e.k === "ability" && e.a === "dash")!;
    const i = out.log.indexOf(dash);
    expect(out.log.slice(i + 1, i + 3).map((e) => e.k)).toEqual(["trap_fired", "core_reached"]);
    expect(out.units[0]!.reachedCoreTick).toBe(dash.t);
  });

  it("two attackers dashing over one trap on the same tick: the lower id springs it (dashes apply in ascending id)", () => {
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 14, y: 6 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 5000 }), unit({ ref: "b", cell: { x: 14, y: 0 }, hp: 5000 })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(341) }));
    const fired = events(out, "trap_fired");
    expect(fired.map((e) => [e.t, e.u])).toEqual([[59, 0]]);
    expect(out.log.filter((e) => e.k === "ability" && e.t === 59).map((e) => (e as { u: number }).u)).toEqual([0, 1]);
  });
});

// ─── D1 ─────────────────────────────────────────────────────────────────────────────────

/** Every unit's fence damage per (tick, fence), normal hits and breaker hits summed. */
function perTick(out: ResolveOutput): Map<string, number> {
  const m = new Map<string, number>();
  const add = (u: number, t: number, f: number, d: number) => m.set(`${u}:${t}:${f}`, (m.get(`${u}:${t}:${f}`) ?? 0) + d);
  for (const e of out.log) {
    if (e.k === "fence_hit") add(e.u, e.t, e.f, e.damage);
    if (e.k === "ability" && e.a === "structure_breaker") add(e.u, e.t, e.tg[0]!.id, e.tg[0]!.amount);
  }
  return m;
}

function assertCapped(out: ResolveOutput, maxHp: (f: number) => number, label: string): number {
  let checked = 0;
  for (const [key, dealt] of perTick(out)) {
    const f = Number(key.split(":")[2]);
    expect(dealt, `${label} unit:tick:fence ${key}`).toBeLessThanOrEqual(Math.max(1, Math.floor(maxHp(f) / 2)));
    checked++;
  }
  return checked;
}

describe("QA-12 D1: FENCE_HIT_SEGMENT_CAP — one per-unit-per-tick fence-hit cap of half the segment's max HP", () => {
  const STONE = { ref: "s", typeId: "siege.blasting_crate", counters: { kind: "fence", category: "stone" } } as const;

  it("the cap is max(1, floor(maxHp × 0.50)); a normal siege hit is clipped to it; the breaker then has only the room left this tick", () => {
    const s = mk(input(battlefield({ fences: [fence({ segment: 3, maxHp: 1000, category: "stone" })] }), party([unit({ ref: "a", ability: BREAKER, mergeLevel: 5, offense: 120 })], [STONE])));
    const a = s.units[0]!;
    const f = s.fences[0]!;
    expect(fenceHitCap(s, f)).toBe(500);
    // Uncapped: floor(120 × 2500/1024) = 292 × 4 = 1168 — the v5 one-blow break of a full Stacked Stone segment.
    expect(fenceHitDamage(s, a, f)).toBe(500);
    s.tick = 7;
    landFenceHit(s, a, f, 500);
    expect(fenceHitRoom(s, a, f)).toBe(0);
    s.tick = 8;
    expect(fenceHitRoom(s, a, f)).toBe(500); // a new tick, a new allowance
    for (const maxHp of [1, 2, 3, 300, 1_000_000]) expect(fenceHitCap(s, { ...f, maxHp })).toBe(Math.max(1, Math.floor(maxHp / 2)));
  });

  it("in a fight: a level-5 offense-120 breaker with stone siege needs two blows on two ticks — phase 6 takes 500, the breaker waits for a tick with room and takes the other 500", () => {
    const out = resolve(input(battlefield({ fences: ringExcept([], 1000).map((x) => ({ ...x, category: "stone" as const })) }), party([unit({ ref: "a", ability: BREAKER, mergeLevel: 5, offense: 120 })], [STONE]), { ...SHORT_TUNABLES, structureBreakerFirstUseMult: fx(0) }));
    const hit = events(out, "fence_hit")[0]!;
    expect(hit).toMatchObject({ damage: 500, hp: 500 });
    const cast = breakerCasts(out)[0]!;
    expect(cast.t).toBe(hit.t + 1);
    expect(cast.tg[0]).toMatchObject({ amount: 500, hp: 0 });
    expect(events(out, "fence_broken")[0]!.t).toBe(hit.t + 1);
  });

  it("same tick, with room: a level-1 offense-120 breaker with stone siege lands 480 in phase 6 and its breaker only the 20 left of the 500", () => {
    const out = resolve(input(battlefield({ fences: ringExcept([], 1000).map((x) => ({ ...x, category: "stone" as const })) }), party([unit({ ref: "a", ability: BREAKER, offense: 120 })], [STONE]), { ...SHORT_TUNABLES, structureBreakerFirstUseMult: fx(0) }));
    const hit = events(out, "fence_hit")[0]!;
    const cast = breakerCasts(out)[0]!;
    expect(hit.damage).toBe(480);
    expect(cast.t).toBe(hit.t);
    expect(cast.tg[0]).toMatchObject({ amount: 20, hp: 500 });
  });

  it("buffed hits obey it too: a ×64-buffed unit's fence hits never exceed half the segment per tick", () => {
    const huge = { ...BUFF, damageBonus: fx(63 * 1024), cooldown: 1000 as never };
    const out = resolve(input(battlefield({ fences: ringExcept([], 300) }), party([unit({ ref: "a", ability: huge, offense: 120, mergeLevel: 5 })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0) }));
    expect(out.log.some((e) => e.k === "ability" && e.a === "self_buff")).toBe(true);
    expect(events(out, "fence_hit").every((h) => h.damage <= 150)).toBe(true);
    expect(assertCapped(out, () => 300, "buffed")).toBeGreaterThan(0);
  });

  it("exhaustive over literal rosters: offense 40/95/120 × merge 1–5 × siege on/off × every tier HP × {normal, self buff ×1.4, breaker ×5.5} — no unit ever takes more than half a segment in one tick, and no full segment breaks to fewer than two blows on two ticks from one unit", () => {
    let fights = 0;
    let groups = 0;
    const bigBuff = { ...BUFF, damageBonus: fx(410) };
    const bigBreaker = breakerWith(5632);
    for (const offense of [40, 95, 120])
      for (let level = 1; level <= 5; level++)
        for (const siege of [false, true])
          for (const hp of [300, 400, 650, 1000])
            for (const ability of [DASH, bigBuff, bigBreaker]) {
              const out = resolve(
                input(
                  battlefield({ fences: ringExcept([], hp) }),
                  party([unit({ ref: "a", ability, offense, mergeLevel: level })], siege ? [{ ref: "s", typeId: "siege.battering_wagon", counters: { kind: "fence", category: "timber" } }] : []),
                  { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(0), structureBreakerFirstUseMult: fx(0) },
                ),
              );
              const label = `o${offense} L${level} ${siege ? "siege" : ""} hp${hp} ${ability.archetype}`;
              groups += assertCapped(out, () => hp, label);
              for (const broken of events(out, "fence_broken")) {
                const ticks = new Set([...perTick(out).keys()].filter((k) => k.endsWith(`:${broken.f}`)).map((k) => k.split(":")[1]));
                expect(ticks.size, `${label}: segment ${broken.f} broke in ${ticks.size} tick(s)`).toBeGreaterThanOrEqual(2);
              }
              fights++;
            }
    expect(fights).toBe(3 * 5 * 2 * 4 * 3);
    expect(groups).toBeGreaterThan(fights);
  });

  it("over the whole determinism corpus, every unit's fence damage per tick is within the cap", () => {
    let groups = 0;
    for (const { name, input: inp } of scenarios()) {
      const out = resolve(clone(inp));
      groups += assertCapped(out, (f) => inp.battlefield.fences[f]!.maxHp, name);
    }
    expect(groups).toBeGreaterThan(50);
  });

  it("the breach price uses the capped hit: breaching a 300-HP segment at ×4 siege costs two blows (one cooldown), never zero", () => {
    // Pinned end to end in combat.test.ts (sealed ring: 150 + 150, one cooldown apart).
    const s = mk(input(battlefield({ fences: [fence({ segment: 3, maxHp: 300 })] }), party([unit({ ref: "a" })], [{ ref: "s", typeId: "x", counters: { kind: "fence", category: "timber" } }])));
    expect(fenceHitDamage(s, s.units[0]!, s.fences[0]!)).toBe(150);
  });
});

// ─── D2 ─────────────────────────────────────────────────────────────────────────────────

describe("QA-12 D2: STRUCTURE_BREAKER_FIRST_USE_MULT — the breaker first readies at ×0.25 of its cooldown", () => {
  it("a 12 s breaker is first ready on tick 60 (= floor(240 × 256/1024)); every other archetype keeps the general ×1.0 delay", () => {
    const s = mk(input(battlefield({ posts: [post("p", { x: 4, y: 4 }, { ability: BREAKER }), post("q", { x: 5, y: 4 }, { ability: BURST })] }), party([unit({ ref: "a", ability: BREAKER }), unit({ ref: "b", ability: HEAVY })])));
    expect(s.units.map((u) => u.abilityReadyTick)).toEqual([60, 300, 60, 240]);
    const t = mk(input(battlefield(), party([unit({ ref: "a", ability: BREAKER })]), { ...DEFAULT_TUNABLES, structureBreakerFirstUseMult: fx(1024), abilityFirstUseDelayMult: fx(0) }));
    expect(t.units[0]!.abilityReadyTick).toBe(240);
  });

  it("with real numbers a breaker now fires on its first fence: sealed 400-HP ring, offense 50 breaker at ×4.5", () => {
    const out = resolve(input(battlefield({ fences: ringExcept([], 400) }), party([unit({ ref: "a", ability: breakerWith(4608), offense: 50 })]), SHORT_TUNABLES));
    const casts = breakerCasts(out);
    expect(casts.length).toBeGreaterThan(0);
    expect(casts[0]!.t).toBeLessThan(events(out, "fence_broken")[0]!.t + 1);
  });
});

// ─── S3 ─────────────────────────────────────────────────────────────────────────────────

describe("QA-12 S3: merge × buff is one product with one floor", () => {
  it("scaleInt2 = floor(v × a × b / 1024²) exactly, including at the input bounds where v × a × b exceeds 2^53", () => {
    const exact = (v: number, a: number, b: number): number => Number((BigInt(v) * BigInt(a) * BigInt(b)) / 1048576n);
    const vs = [0, 1, 13, 57, 1023, 65_537, 1_000_000, 64_000_000];
    const ms = [1024, 1280, 1331, 1600, 2500, 65_536, 66_560, 1, 1023];
    for (const v of vs) for (const a of ms) for (const b of ms) expect(scaleInt2(v, a as Fixed, b as Fixed), `${v} ${a} ${b}`).toBe(exact(v, a, b));
    expect(64_000_000 * 65_536 * 66_560).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(INPUT_BOUNDS.maxMult).toBe(65_536);
  });

  it("a buffed hit of 13 at merge ×1.25 with +30 % (1331/1024) is floor(13 × 1.25 × 1.2998) = 21, where two floors gave floor(16 × 1.2998) = 20", () => {
    const s = mk(input(battlefield(), party([unit({ ref: "a", ability: BUFF, mergeLevel: 2 })])));
    const a = s.units[0]!;
    expect(dealtOutput(s, a, 13)).toBe(16);
    s.tick = 5;
    a.buffEndTick = 5;
    expect(dealtOutput(s, a, 13)).toBe(21);
  });
});

// ─── N1 / N2 ────────────────────────────────────────────────────────────────────────────

describe("QA-12 N1/N2: ABILITY_SKIP_VOID — a void firing is skipped, nothing spent", () => {
  it("N1: a posted dasher brought to 0 HP earlier in phase 7 (by an attacker's heavy strike, lower id) does not dash, and stays ready", () => {
    for (const hp of [100, 1000]) {
      const s = mk(input(battlefield({ posts: [post("g", { x: 10, y: 14 }, { ability: DASH, hp, maxHp: 1000 })] }), party([unit({ ref: "a", ability: HEAVY, attackRange: fx(6 * 1024), hp: 1_000_000 })])));
      const a = s.units[0]!;
      const g = s.units[1]!;
      place(a, C(10), C(10));
      place(g, C(10), C(14));
      g.postMode = "pursuing";
      g.target = { kind: "unit", id: 0 };
      g.waypoints = [{ x: C(10) as Fixed, y: C(11) as Fixed, breach: -1 }];
      g.legLen = -1;
      a.abilityReadyTick = 0;
      g.abilityReadyTick = 0;
      s.tick = 0;
      const log: LogEvent[] = [];
      abilityPhase(s, log);
      const abs = log.filter((e): e is Extract<LogEvent, { k: "ability" }> => e.k === "ability");
      if (hp === 1000) {
        // Control: the strike (140) is not lethal, so the same post does dash.
        expect(abs.map((e) => [e.u, e.a])).toEqual([[0, "heavy_strike"], [1, "dash"]]);
        continue;
      }
      expect(abs.map((e) => [e.u, e.a])).toEqual([[0, "heavy_strike"]]);
      expect(g.hp).toBe(0);
      expect([g.x, g.y]).toEqual([C(10), C(14)]);
      expect(g.abilityReadyTick).toBe(0);
    }
  });

  it("N2: a self buff from a caster already at 0 HP (it dies in phase 8) is skipped — no event, no buff, still ready", () => {
    const s = mk(input(battlefield({ posts: [post("p", { x: 10, y: 11 })] }), party([unit({ ref: "a", ability: BUFF, hp: 1000 })])));
    const a = s.units[0]!;
    place(a, C(10), C(10));
    a.hp = 0;
    a.abilityReadyTick = 0;
    s.tick = 3;
    const log: LogEvent[] = [];
    abilityPhase(s, log);
    expect(log).toEqual([]);
    expect(a.buffEndTick).toBe(-1);
    expect(a.abilityReadyTick).toBe(0);
    // Control: alive, the same caster buffs.
    a.hp = 1;
    abilityPhase(s, log);
    expect(log).toMatchObject([{ k: "ability", a: "self_buff", u: 0 }]);
  });
});
