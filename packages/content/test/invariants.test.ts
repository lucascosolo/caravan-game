/**
 * Structural invariants from the chunk 03 brief. Tests MAY use floats to measure; the
 * content itself may not contain any (see no-floats.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  ABILITY_ARCHETYPES,
  AFFINITY_CATEGORIES,
  AFFINITY_MATRIX,
  CONTENT,
  REGIONS,
  FENCE_CATEGORIES,
  FENCE_TIERS,
  FIXED_POINT_SCALE,
  LIVING_UNIT_TYPES,
  REGION_IDS,
  SIEGE_TYPES,
  TRAP_CATEGORIES,
  TRAP_TYPES,
  TUNABLES,
  abilityDisplay,
  abilityFirstUseMs,
  affinityMult,
  isDeepFrozen,
  mergeStatMult,
  scaleInt,
  unitsForRegion,
  validateContent,
  type AffinityCategory,
  type Fixed,
} from "../src/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("content loads and validates", () => {
  it("validateContent reports no problems for the shipped bundle", () => {
    expect(validateContent(CONTENT)).toEqual([]);
  });

  it("roster size matches the registry", () => {
    expect(LIVING_UNIT_TYPES).toHaveLength(TUNABLES.LIVING_UNITS_PER_REGION * TUNABLES.REGION_COUNT);
    for (const r of REGION_IDS) expect(unitsForRegion(r)).toHaveLength(TUNABLES.LIVING_UNITS_PER_REGION);
    expect(TRAP_TYPES).toHaveLength(TUNABLES.TRAP_TYPES);
    expect(SIEGE_TYPES).toHaveLength(TUNABLES.SIEGE_TYPES);
    expect(FENCE_TIERS).toHaveLength(TUNABLES.FENCE_TIERS);
    expect(AFFINITY_CATEGORIES).toHaveLength(TUNABLES.AFFINITY_CATEGORIES);
    expect(ABILITY_ARCHETYPES).toHaveLength(TUNABLES.ABILITY_ARCHETYPE_COUNT);
  });

  it("validation catches dangling references and missing fields", () => {
    const first = LIVING_UNIT_TYPES[0]!;
    const broken = {
      ...CONTENT,
      units: [{ ...first, affinity: "steam" as AffinityCategory }, ...LIVING_UNIT_TYPES.slice(1)],
      siege: [{ ...SIEGE_TYPES[0]!, counters: { kind: "fence" as const, category: "adobe" as never } }, ...SIEGE_TYPES.slice(1)],
      traps: [{ ...TRAP_TYPES[0]!, damage: 9999 }, ...TRAP_TYPES.slice(1)],
    };
    const problems = validateContent(broken);
    expect(problems.some((p) => p.includes("unknown affinity 'steam'"))).toBe(true);
    expect(problems.some((p) => p.includes("unknown fence category 'adobe'"))).toBe(true);
    expect(problems.some((p) => p.includes("'timber' has no siege counter"))).toBe(true);
    expect(problems.some((p) => p.includes("damage=9999"))).toBe(true);

    const noAbility = { ...CONTENT, units: [{ ...first, ability: undefined as never }, ...LIVING_UNIT_TYPES.slice(1)] };
    expect(validateContent(noAbility).some((p) => p.includes("ability is required"))).toBe(true);

    const procChance = {
      ...CONTENT,
      units: [{ ...first, ability: { ...first.ability, procChance: 50 } as never }, ...LIVING_UNIT_TYPES.slice(1)],
    };
    expect(validateContent(procChance).some((p) => p.includes("ability: unexpected field 'procChance'"))).toBe(true);
  });

  it("rejects a smuggled 'critChance' on every shape: unit, trap, trap.effect, siege, siege.counters, fence (QA S3)", () => {
    const unit = LIVING_UNIT_TYPES[0]!;
    const slowTrap = TRAP_TYPES.find((t) => t.effect?.kind === "slow")!;
    const rootTrap = TRAP_TYPES.find((t) => t.effect?.kind === "root")!;
    const siege = SIEGE_TYPES[0]!;
    const fence = FENCE_TIERS[0]!;
    const smuggle = <T extends object>(x: T): T => ({ ...x, critChance: 5 }) as T;
    const cases: { name: string; bundle: typeof CONTENT; expectMsg: string }[] = [
      { name: "unit", bundle: { ...CONTENT, units: [smuggle(unit), ...LIVING_UNIT_TYPES.slice(1)] }, expectMsg: `unit '${unit.id}': unexpected field 'critChance'` },
      { name: "trap", bundle: { ...CONTENT, traps: [smuggle(slowTrap), ...TRAP_TYPES.filter((t) => t !== slowTrap)] }, expectMsg: `trap '${slowTrap.id}': unexpected field 'critChance'` },
      {
        name: "trap.effect (slow)",
        bundle: { ...CONTENT, traps: [{ ...slowTrap, effect: smuggle(slowTrap.effect!) }, ...TRAP_TYPES.filter((t) => t !== slowTrap)] },
        expectMsg: `trap '${slowTrap.id}' effect: unexpected field 'critChance'`,
      },
      {
        name: "trap.effect (root)",
        bundle: { ...CONTENT, traps: [{ ...rootTrap, effect: smuggle(rootTrap.effect!) }, ...TRAP_TYPES.filter((t) => t !== rootTrap)] },
        expectMsg: `trap '${rootTrap.id}' effect: unexpected field 'critChance'`,
      },
      { name: "siege", bundle: { ...CONTENT, siege: [smuggle(siege), ...SIEGE_TYPES.slice(1)] }, expectMsg: `siege '${siege.id}': unexpected field 'critChance'` },
      {
        name: "siege.counters",
        bundle: { ...CONTENT, siege: [{ ...siege, counters: smuggle(siege.counters) }, ...SIEGE_TYPES.slice(1)] },
        expectMsg: `siege '${siege.id}' counters: unexpected field 'critChance'`,
      },
      { name: "fence", bundle: { ...CONTENT, fences: [smuggle(fence), ...FENCE_TIERS.slice(1)] }, expectMsg: `fence '${fence.id}': unexpected field 'critChance'` },
      { name: "ability", bundle: { ...CONTENT, units: [{ ...unit, ability: smuggle(unit.ability) }, ...LIVING_UNIT_TYPES.slice(1)] }, expectMsg: `unit '${unit.id}' ability: unexpected field 'critChance'` },
    ];
    for (const c of cases) {
      const problems = validateContent(c.bundle);
      expect(problems, c.name).toContain(c.expectMsg);
    }
    // And the shipped bundle has no stray key anywhere (belt and braces over the load-time check).
    expect(validateContent(CONTENT)).toEqual([]);
  });

  it("every export is deep-frozen and assignment throws (QA S2)", () => {
    for (const [name, x] of Object.entries({ CONTENT, LIVING_UNIT_TYPES, TRAP_TYPES, SIEGE_TYPES, FENCE_TIERS, TUNABLES, AFFINITY_MATRIX, REGIONS, REGION_IDS, AFFINITY_CATEGORIES, ABILITY_ARCHETYPES, TRAP_CATEGORIES, FENCE_CATEGORIES })) {
      expect(isDeepFrozen(x), name).toBe(true);
    }
    const unit = LIVING_UNIT_TYPES[0]! as { offense: number; ability: { cooldown: number } };
    expect(() => {
      unit.offense = 9999;
    }).toThrow(TypeError);
    expect(() => {
      unit.ability.cooldown = 1;
    }).toThrow(TypeError);
    expect(() => {
      (TUNABLES as { MERGE_LEVEL_MAX: number }).MERGE_LEVEL_MAX = 6;
    }).toThrow(TypeError);
    expect(() => {
      (TUNABLES.MERGE_STAT_MULT_BY_LEVEL as unknown as number[])[5] = 99999;
    }).toThrow(TypeError);
    expect(() => {
      (AFFINITY_MATRIX as { grit: { beast: string } }).grit.beast = "advantage";
    }).toThrow(TypeError);
    expect(() => {
      (LIVING_UNIT_TYPES as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (CONTENT as { units: unknown }).units = [];
    }).toThrow(TypeError);
    expect(() => {
      (REGIONS as unknown as unknown[]).pop();
    }).toThrow(TypeError);
    expect(TUNABLES.MERGE_LEVEL_MAX).toBe(5);
    expect(LIVING_UNIT_TYPES[0]!.offense).not.toBe(9999);
  });

  it("category counts live in the registry and SIEGE_TYPES is their sum (QA N4)", () => {
    expect(FENCE_CATEGORIES).toHaveLength(TUNABLES.FENCE_CATEGORY_COUNT);
    expect(TRAP_CATEGORIES).toHaveLength(TUNABLES.TRAP_CATEGORY_COUNT);
    expect(TUNABLES.SIEGE_TYPES).toBe(TUNABLES.FENCE_CATEGORY_COUNT + TUNABLES.TRAP_CATEGORY_COUNT);
    expect(SIEGE_TYPES).toHaveLength(TUNABLES.FENCE_CATEGORY_COUNT + TUNABLES.TRAP_CATEGORY_COUNT);
  });
});

describe("merge curve is a slot-efficiency gain, never a power gain (GUARDRAILS §2)", () => {
  // The decision (chunk 03 QA B1): the merge multiplier applies LINEARLY to max HP and to
  // post-formula damage output, never to the ratings that enter o²/(o+d). So the unit of
  // comparison is EFFECTIVE STRENGTH = HP × actual damage per hit, computed exactly as the
  // resolver will (floor on the formula, floor on each fixed-point scale), for every unit
  // type in both roles against every roster opponent and every affinity outcome. "Worst-case
  // (o, d)" is therefore not a chosen pair: it is every pair the roster can produce.
  const formulaHit = (o: number, d: number): number => Math.floor((o * o) / (o + d));
  const hitAt = (o: number, d: number, level: number, aff: Fixed): number =>
    scaleInt(scaleInt(formulaHit(o, d), aff), mergeStatMult(level));
  const hpAt = (hp: number, level: number): number => scaleInt(hp, mergeStatMult(level));
  const AFFINITY_MULTS = [affinityMult("advantage"), affinityMult("neutral"), affinityMult("disadvantage")];

  it("produced effective strength < spent effective strength, every unit, every opponent, every level, both recipes", () => {
    let checks = 0;
    let worst = 0;
    for (const me of LIVING_UNIT_TYPES) {
      for (const them of LIVING_UNIT_TYPES) {
        // Both roles: I raid (my offense vs. their defense) and I guard (my defense vs. their offense).
        for (const [o, d] of [
          [me.offense, them.defense],
          [me.defense, them.offense],
        ] as const) {
          for (const aff of AFFINITY_MULTS) {
            for (let level = TUNABLES.MERGE_LEVEL_MIN; level < TUNABLES.MERGE_LEVEL_MAX; level++) {
              const here = hpAt(me.hp, level) * hitAt(o, d, level, aff);
              const next = hpAt(me.hp, level + 1) * hitAt(o, d, level + 1, aff);
              expect(here).toBeGreaterThan(0);
              expect(next).toBeGreaterThan(here);
              for (const recipe of TUNABLES.MERGE_RECIPES) {
                const produced = recipe.produce * next;
                const spent = recipe.spend * here;
                expect(produced, `${me.id} vs ${them.id} (o=${o}, d=${d}) L${level}→L${level + 1} ${recipe.spend}→${recipe.produce}`).toBeLessThan(spent);
                worst = Math.max(worst, produced / spent);
                checks++;
              }
            }
          }
        }
      }
    }
    expect(checks).toBe(LIVING_UNIT_TYPES.length ** 2 * 2 * 3 * (TUNABLES.MERGE_LEVEL_MAX - 1) * TUNABLES.MERGE_RECIPES.length);
    // Before rounding the worst recipe sits at 3k²/5 = 0.9375. Floor rounding on the roster's
    // SMALLEST hit (o=40 vs d=120 at disadvantage: 7 damage) eats most of that margin at
    // L3→L4 and L4→L5 (13/10 and 17/13 instead of 1.25), so the rounding-inclusive worst is
    // ~0.98. Still strictly below 1 everywhere, which is the guardrail; this pins the margin
    // so a future roster or multiplier change that erodes it further is noticed.
    const theoretical = (3 * (TUNABLES.MERGE_MULT_PER_LEVEL / FIXED_POINT_SCALE) ** 2) / 5;
    expect(theoretical).toBeLessThan(0.94);
    expect(worst).toBeLessThan(0.99);
  });

  it("chunk 12 QA S3: HP × effective DPS INCLUDING each type's ability stays under 5/3 per level and both recipes — every type, both roles, every opponent, every affinity", () => {
    // The resolver's pipeline exactly: formula floor → affinity floor → merge (and, while the
    // self buff is in force, merge × buff with ONE floor) → ability multiplier floor → min 1.
    // Ability contribution: self buff by its duty cycle (duration / cooldown of the caster's
    // hits carry the buffed hit); heavy strike and burst as one ability hit per interval,
    // the interval taken both as the cooldown (steady state) and as the first-use delay
    // (the opening of a fight). Heal, dash and breaker deal no unit damage.
    const firstUseMult = (a: { archetype: string }): number => (a.archetype === "structure_breaker" ? TUNABLES.STRUCTURE_BREAKER_FIRST_USE_MULT : TUNABLES.ABILITY_FIRST_USE_DELAY_MULT);
    const oneFloor = (v: number, a: number, b: number): number => Math.floor((v * a * b) / (FIXED_POINT_SCALE * FIXED_POINT_SCALE));
    let worst = 0;
    let worstAt = "";
    let checks = 0;
    for (const me of LIVING_UNIT_TYPES) {
      const a = me.ability;
      for (const them of LIVING_UNIT_TYPES) {
        for (const [o, d] of [
          [me.offense, them.defense],
          [me.defense, them.offense],
        ] as const) {
          for (const aff of AFFINITY_MULTS) {
            for (const interval of ["cooldown", "firstUse"] as const) {
              const strength = (level: number): number => {
                const base = scaleInt(formulaHit(o, d), aff);
                const hit = Math.max(1, scaleInt(base, mergeStatMult(level)));
                let dps = hit / me.attackCooldown;
                if (a.archetype === "heavy_strike" || a.archetype === "burst_radius") {
                  const every = interval === "cooldown" ? a.cooldown : Math.max(1, (a.cooldown * firstUseMult(a)) / FIXED_POINT_SCALE);
                  dps += Math.max(1, scaleInt(scaleInt(base, mergeStatMult(level)), a.damageMult)) / every;
                }
                if (a.archetype === "self_buff") {
                  const buffed = Math.max(1, oneFloor(base, mergeStatMult(level), FIXED_POINT_SCALE + a.damageBonus));
                  const f = Math.min(a.duration, a.cooldown) / a.cooldown;
                  dps = (hit * (1 - f) + buffed * f) / me.attackCooldown;
                }
                return hpAt(me.hp, level) * dps;
              };
              for (let level = TUNABLES.MERGE_LEVEL_MIN; level < TUNABLES.MERGE_LEVEL_MAX; level++) {
                const here = strength(level);
                const next = strength(level + 1);
                for (const recipe of TUNABLES.MERGE_RECIPES) {
                  const line = `${me.id} vs ${them.id} (o=${o}, d=${d}, aff ${aff}, ${interval}) L${level}→L${level + 1} ${recipe.spend}→${recipe.produce}`;
                  expect(recipe.produce * next, line).toBeLessThan(recipe.spend * here);
                  checks++;
                }
                expect(next / here).toBeLessThan(TUNABLES.MERGE_EFFECTIVE_CEILING / FIXED_POINT_SCALE);
                if (next / here > worst) {
                  worst = next / here;
                  worstAt = `${me.id} (o=${o}, d=${d}, aff ${aff}, ${interval}) L${level}→L${level + 1}`;
                }
              }
            }
          }
        }
      }
    }
    expect(checks).toBe(LIVING_UNIT_TYPES.length ** 2 * 2 * 3 * 2 * (TUNABLES.MERGE_LEVEL_MAX - 1) * TUNABLES.MERGE_RECIPES.length);
    // Pinned so erosion is noticed: the one-floor buff brought the worst step from 1.6856
    // (vulture flock, two floors) to 1.6402 (a posted gunslinger vs an offense-120 raider at disadvantage, L3→L4).
    expect(worst, worstAt).toBeLessThan(1.65);
  });

  it("the raw table is ×1.25 per level and k² stays under the registry's 5/3 ceiling", () => {
    const ceiling = TUNABLES.MERGE_EFFECTIVE_CEILING / FIXED_POINT_SCALE;
    for (let level = TUNABLES.MERGE_LEVEL_MIN; level < TUNABLES.MERGE_LEVEL_MAX; level++) {
      const k = mergeStatMult(level + 1) / mergeStatMult(level);
      expect(k).toBeGreaterThan(1);
      expect(k * k).toBeLessThan(ceiling);
      expect(k * k).toBeLessThan(2);
      expect(mergeStatMult(level + 1)).toBe(scaleInt(mergeStatMult(level), TUNABLES.MERGE_MULT_PER_LEVEL));
    }
    expect(TUNABLES.MERGE_MULT_PER_LEVEL / FIXED_POINT_SCALE).toBe(1.25);
    expect(mergeStatMult(1)).toBe(FIXED_POINT_SCALE);
    expect(() => mergeStatMult(0)).toThrow(RangeError);
    expect(() => mergeStatMult(6)).toThrow(RangeError);
  });

  it("declares, as data, that the multiplier applies to hp and damage output only — never ratings or abilities", () => {
    expect([...TUNABLES.MERGE_MULT_APPLIES_TO]).toEqual(["hp", "damage_output"]);
    expect(TUNABLES.MERGE_MULT_SCALES_ABILITY_FIELDS).toBe(false);
    for (const field of ["offense", "defense", "ability"]) {
      expect(TUNABLES.MERGE_MULT_APPLIES_TO as readonly string[]).not.toContain(field);
      expect(TUNABLES.MERGE_MULT_NEVER_APPLIES_TO as readonly string[]).toContain(field);
    }
    // Nothing is both applied-to and never-applied-to, and nothing on the never list is a key the unit shape lacks.
    for (const f of TUNABLES.MERGE_MULT_NEVER_APPLIES_TO) {
      expect(TUNABLES.MERGE_MULT_APPLIES_TO as readonly string[]).not.toContain(f);
      expect(Object.keys(LIVING_UNIT_TYPES[0]!)).toContain(f);
    }
  });
});

describe("offense and defense are independent ratings", () => {
  const ratios = LIVING_UNIT_TYPES.map((u) => u.offense / u.defense);

  it("is not a fixed ratio across the roster", () => {
    expect(new Set(ratios.map((r) => r.toFixed(3))).size).toBeGreaterThan(LIVING_UNIT_TYPES.length / 2);
    expect(Math.min(...ratios)).toBeLessThan(0.6);
    expect(Math.max(...ratios)).toBeGreaterThan(1.8);
  });

  it("has low linear correlation between offense and defense", () => {
    const xs = LIVING_UNIT_TYPES.map((u) => u.offense);
    const ys = LIVING_UNIT_TYPES.map((u) => u.defense);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      dx += (xs[i]! - mx) ** 2;
      dy += (ys[i]! - my) ** 2;
    }
    const r = num / Math.sqrt(dx * dy);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  it("every region has units that lean offense and units that lean defense", () => {
    for (const region of REGION_IDS) {
      const units = unitsForRegion(region);
      expect(units.some((u) => u.offense > u.defense)).toBe(true);
      expect(units.some((u) => u.defense > u.offense)).toBe(true);
    }
  });
});

describe("regions are mechanically distinct", () => {
  const statBlock = (u: (typeof LIVING_UNIT_TYPES)[number]) =>
    [u.offense, u.defense, u.hp, u.moveSpeed, u.attackRange, u.attackCooldown, u.aggroRadius, u.leashDistance].join("/");

  it("no two unit types share a stat block (within or across regions)", () => {
    const blocks = LIVING_UNIT_TYPES.map(statBlock);
    expect(new Set(blocks).size).toBe(blocks.length);
  });

  it("no two regions share an (affinity, archetype) profile or an aggro/leash profile", () => {
    const profiles = REGION_IDS.map((r) =>
      unitsForRegion(r)
        .map((u) => `${u.affinity}:${u.ability.archetype}:${u.aggroRadius}/${u.leashDistance}`)
        .sort()
        .join(","),
    );
    expect(new Set(profiles).size).toBe(REGION_IDS.length);
  });

  it("every region mixes at least two affinity categories and four ability archetypes", () => {
    for (const r of REGION_IDS) {
      const units = unitsForRegion(r);
      expect(new Set(units.map((u) => u.affinity)).size).toBeGreaterThanOrEqual(2);
      expect(new Set(units.map((u) => u.ability.archetype)).size).toBeGreaterThanOrEqual(4);
    }
  });

  it("every affinity category appears in every region", () => {
    for (const r of REGION_IDS) {
      const cats = new Set(unitsForRegion(r).map((u) => u.affinity));
      for (const c of AFFINITY_CATEGORIES) expect(cats.has(c)).toBe(true);
    }
  });
});

describe("abilities", () => {
  it("every living-unit type has exactly one ability, from the six archetypes", () => {
    for (const u of LIVING_UNIT_TYPES) {
      expect(ABILITY_ARCHETYPES).toContain(u.ability.archetype);
      expect(Array.isArray(u.ability)).toBe(false);
      expect(Object.keys(u).filter((k) => k.startsWith("abilit"))).toEqual(["ability"]);
    }
  });

  it("all six archetypes are used across the roster", () => {
    const used = new Set(LIVING_UNIT_TYPES.map((u) => u.ability.archetype));
    for (const a of ABILITY_ARCHETYPES) expect(used.has(a)).toBe(true);
  });

  it("cooldowns are within the registry range and long relative to attack cooldowns", () => {
    for (const u of LIVING_UNIT_TYPES) {
      expect(u.ability.cooldown).toBeGreaterThanOrEqual(TUNABLES.ABILITY_COOLDOWN_MIN);
      expect(u.ability.cooldown).toBeLessThanOrEqual(TUNABLES.ABILITY_COOLDOWN_MAX);
      expect(u.ability.cooldown).toBeGreaterThan(u.attackCooldown * 2);
    }
  });

  it("healers are bounded by the registry's finite charge count and every region has one", () => {
    const healers = LIVING_UNIT_TYPES.filter((u) => u.ability.archetype === "heal_radius");
    expect(healers.length).toBeGreaterThan(0);
    for (const h of healers) {
      expect(h.ability.archetype === "heal_radius" && h.ability.charges).toBe(TUNABLES.HEAL_CHARGES_PER_BATTLE);
    }
    for (const r of REGION_IDS) expect(unitsForRegion(r).some((u) => u.ability.archetype === "heal_radius")).toBe(true);
  });

  it("no ability carries chance, variance or random-target data", () => {
    const banned = /chance|random|variance|crit|proc|roll|luck/i;
    for (const u of LIVING_UNIT_TYPES) {
      for (const key of Object.keys(u.ability)) expect(key).not.toMatch(banned);
    }
  });
});

describe("unit stats stay inside the registry bounds and use rates, not ticks", () => {
  it("ratings, hp, speed, range and cooldowns are within bounds", () => {
    for (const u of LIVING_UNIT_TYPES) {
      expect(u.offense).toBeGreaterThanOrEqual(TUNABLES.BASE_OFFENSE_MIN);
      expect(u.offense).toBeLessThanOrEqual(TUNABLES.BASE_OFFENSE_MAX);
      expect(u.defense).toBeGreaterThanOrEqual(TUNABLES.BASE_DEFENSE_MIN);
      expect(u.defense).toBeLessThanOrEqual(TUNABLES.BASE_DEFENSE_MAX);
      expect(u.hp).toBeGreaterThanOrEqual(TUNABLES.UNIT_HP_MIN);
      expect(u.hp).toBeLessThanOrEqual(TUNABLES.UNIT_HP_MAX);
      expect(u.moveSpeed).toBeGreaterThanOrEqual(TUNABLES.MOVE_SPEED_MIN);
      expect(u.moveSpeed).toBeLessThanOrEqual(TUNABLES.MOVE_SPEED_MAX);
      expect(u.attackCooldown).toBeGreaterThanOrEqual(TUNABLES.ATTACK_COOLDOWN_MIN);
      expect(u.attackCooldown).toBeLessThanOrEqual(TUNABLES.ATTACK_COOLDOWN_MAX);
      expect(u.attackRange).toBeGreaterThanOrEqual(TUNABLES.ATTACK_RANGE_MELEE_DEFAULT);
      expect(u.leashDistance + u.attackRange).toBeGreaterThanOrEqual(u.aggroRadius);
    }
  });

  it("the full authored spread is actually used (the ranges are not decorative)", () => {
    expect(Math.min(...LIVING_UNIT_TYPES.map((u) => u.offense))).toBe(TUNABLES.BASE_OFFENSE_MIN);
    expect(Math.max(...LIVING_UNIT_TYPES.map((u) => u.offense))).toBe(TUNABLES.BASE_OFFENSE_MAX);
    expect(Math.min(...LIVING_UNIT_TYPES.map((u) => u.defense))).toBe(TUNABLES.BASE_DEFENSE_MIN);
    expect(Math.min(...LIVING_UNIT_TYPES.map((u) => u.hp))).toBe(TUNABLES.UNIT_HP_MIN);
    expect(Math.max(...LIVING_UNIT_TYPES.map((u) => u.hp))).toBe(TUNABLES.UNIT_HP_MAX);
    expect(Math.max(...LIVING_UNIT_TYPES.map((u) => u.moveSpeed))).toBe(TUNABLES.MOVE_SPEED_MAX);
    expect(Math.min(...LIVING_UNIT_TYPES.map((u) => u.attackCooldown))).toBe(TUNABLES.ATTACK_COOLDOWN_MIN);
    expect(Math.max(...LIVING_UNIT_TYPES.map((u) => u.attackCooldown))).toBe(TUNABLES.ATTACK_COOLDOWN_MAX);
  });

  it("there are both melee and ranged units, decided by range alone", () => {
    expect(LIVING_UNIT_TYPES.some((u) => u.attackRange === TUNABLES.ATTACK_RANGE_MELEE_DEFAULT)).toBe(true);
    expect(LIVING_UNIT_TYPES.some((u) => u.attackRange >= TUNABLES.ATTACK_RANGE_RANGED_DEFAULT)).toBe(true);
    for (const u of LIVING_UNIT_TYPES) expect("isRanged" in u).toBe(false);
  });

  it("no content key or registry key mentions ticks", () => {
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    walk(CONTENT);
    walk(TUNABLES);
    // The one exception: TICK_RATE itself is the resolver's clock (chunk 10), the thing every
    // millisecond duration is converted AGAINST. Every other key, including the resolver's
    // own intervals, is authored in ms and converted by the resolver at setup.
    for (const k of keys) if (k !== "TICK_RATE") expect(k.toLowerCase()).not.toContain("tick");
    for (const k of Object.keys(TUNABLES)) if (k !== "TICK_RATE") expect(k.toUpperCase()).not.toContain("TICK");
    expect(TUNABLES.TICK_RATE).toBe(20);
    expect(1000 % TUNABLES.TICK_RATE).toBe(0);
  });
});

describe("affinity matrix", () => {
  it("is complete and every category both beats and is beaten by another", () => {
    for (const a of AFFINITY_CATEGORIES) {
      expect(AFFINITY_MATRIX[a][a]).toBe("neutral");
      const row = AFFINITY_CATEGORIES.map((b) => AFFINITY_MATRIX[a][b]);
      expect(row).toContain("advantage");
      expect(row).toContain("disadvantage");
      for (const b of AFFINITY_CATEGORIES) {
        // antisymmetric: if a beats b, b loses to a
        const ab = AFFINITY_MATRIX[a][b];
        const ba = AFFINITY_MATRIX[b][a];
        if (ab === "advantage") expect(ba).toBe("disadvantage");
        if (ab === "disadvantage") expect(ba).toBe("advantage");
        if (ab === "neutral") expect(ba).toBe("neutral");
      }
    }
  });

  it("multipliers bracket neutral and are fixed-point", () => {
    expect(affinityMult("advantage")).toBeGreaterThan(FIXED_POINT_SCALE);
    expect(affinityMult("disadvantage")).toBeLessThan(FIXED_POINT_SCALE);
    expect(affinityMult("neutral")).toBe(FIXED_POINT_SCALE);
  });

  it("traps and units both carry an affinity category from the matrix", () => {
    for (const t of TRAP_TYPES) expect(AFFINITY_CATEGORIES).toContain(t.affinity);
    for (const u of LIVING_UNIT_TYPES) expect(AFFINITY_CATEGORIES).toContain(u.affinity);
  });
});

describe("siege counters are explicit categorical data", () => {
  it("every siege piece counters exactly one category and every category is countered exactly once", () => {
    const fence = SIEGE_TYPES.filter((s) => s.counters.kind === "fence").map((s) => s.counters.category);
    const trap = SIEGE_TYPES.filter((s) => s.counters.kind === "trap").map((s) => s.counters.category);
    expect(fence.length + trap.length).toBe(SIEGE_TYPES.length);
    expect([...fence].sort()).toEqual([...FENCE_CATEGORIES].sort());
    expect([...trap].sort()).toEqual([...TRAP_CATEGORIES].sort());
  });

  it("siege has no stats or abilities — it is a counter, not a unit", () => {
    for (const s of SIEGE_TYPES) {
      for (const k of Object.keys(s)) expect(["id", "displayName", "flavor", "counters"]).toContain(k);
    }
  });

  it("every fence tier and every trap is countered by some piece", () => {
    for (const f of FENCE_TIERS) expect(SIEGE_TYPES.some((s) => s.counters.kind === "fence" && s.counters.category === f.category)).toBe(true);
    for (const t of TRAP_TYPES) expect(SIEGE_TYPES.some((s) => s.counters.kind === "trap" && s.counters.category === t.category)).toBe(true);
  });
});

describe("traps and fences", () => {
  it("trap damage is within range and the spread is used", () => {
    const d = TRAP_TYPES.map((t) => t.damage);
    expect(Math.min(...d)).toBe(TUNABLES.TRAP_DAMAGE_MIN);
    expect(Math.max(...d)).toBe(TUNABLES.TRAP_DAMAGE_MAX);
  });

  it("fence tiers are strictly increasing in HP and include the default", () => {
    const sorted = [...FENCE_TIERS].sort((a, b) => a.tier - b.tier);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.segmentHp).toBeGreaterThan(sorted[i - 1]!.segmentHp);
    expect(sorted.map((f) => f.tier)).toEqual([1, 2, 3, 4]);
    expect(FENCE_TIERS.some((f) => f.segmentHp === TUNABLES.FENCE_SEGMENT_HP_DEFAULT)).toBe(true);
  });
});

describe("legibility: every player-facing number is on the exported data", () => {
  it("units, traps, siege and fences all have a display name and one-line flavour", () => {
    for (const x of [...LIVING_UNIT_TYPES, ...TRAP_TYPES, ...SIEGE_TYPES, ...FENCE_TIERS]) {
      expect(x.displayName.length).toBeGreaterThan(0);
      expect(x.flavor.length).toBeGreaterThan(0);
      expect(x.flavor).not.toContain("\n");
    }
    for (const u of LIVING_UNIT_TYPES) expect(u.ability.description.length).toBeGreaterThan(0);
  });
});

describe("regions are not reskins: cross-region nearest-neighbour stat distance (QA S4)", () => {
  // Metric: the eight numeric unit stats, each min-max normalised over the roster to [0, 1],
  // plus one affinity dimension (0 if the same category, 1 if different); Euclidean distance.
  // Two units at 0.10 differ by about 10 % of the roster's spread on one stat, or ~4 % on
  // several. Below that they are the same unit with different art.
  const STATS = ["offense", "defense", "hp", "moveSpeed", "attackRange", "attackCooldown", "aggroRadius", "leashDistance"] as const;
  const lo = Object.fromEntries(STATS.map((k) => [k, Math.min(...LIVING_UNIT_TYPES.map((u) => u[k]))])) as Record<string, number>;
  const hi = Object.fromEntries(STATS.map((k) => [k, Math.max(...LIVING_UNIT_TYPES.map((u) => u[k]))])) as Record<string, number>;
  const vec = (u: (typeof LIVING_UNIT_TYPES)[number]) => STATS.map((k) => (u[k] - lo[k]!) / (hi[k]! - lo[k]!));
  const distance = (a: (typeof LIVING_UNIT_TYPES)[number], b: (typeof LIVING_UNIT_TYPES)[number]) => {
    const va = vec(a);
    const vb = vec(b);
    let sum = a.affinity === b.affinity ? 0 : 1;
    for (let i = 0; i < va.length; i++) sum += (va[i]! - vb[i]!) ** 2;
    return Math.sqrt(sum);
  };
  const THRESHOLD = 0.1;

  it("every unit's nearest cross-region neighbour is at distance ≥ 0.10", () => {
    for (const a of LIVING_UNIT_TYPES) {
      let best = Number.POSITIVE_INFINITY;
      let who = "";
      for (const b of LIVING_UNIT_TYPES) {
        if (a.regionId === b.regionId) continue;
        const d = distance(a, b);
        if (d < best) (best = d), (who = b.id);
      }
      expect(best, `${a.id} is a reskin of ${who} (distance ${best.toFixed(3)})`).toBeGreaterThanOrEqual(THRESHOLD);
    }
  });

  it("the four healers are four different chassis: distinct range, speed, affinity and aggro/leash profiles", () => {
    const healers = LIVING_UNIT_TYPES.filter((u) => u.ability.archetype === "heal_radius");
    expect(healers).toHaveLength(REGION_IDS.length);
    expect(new Set(healers.map((h) => h.attackRange)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(healers.map((h) => h.moveSpeed)).size).toBe(healers.length);
    expect(new Set(healers.map((h) => h.affinity)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(healers.map((h) => `${h.aggroRadius}/${h.leashDistance}`)).size).toBe(healers.length);
    for (const a of healers) for (const b of healers) if (a !== b) expect(distance(a, b), `${a.id} vs ${b.id}`).toBeGreaterThanOrEqual(0.25);
  });
});

describe("registry reference defaults are referenced, not re-authored (QA S5)", () => {
  const SRC = join(__dirname, "..", "src");
  const read = (f: string) => readFileSync(join(SRC, f), "utf8");
  const authored = (expr: string): number | undefined => {
    const m = /^(fp|fpMilli|seconds|ms)\((\d+)\)$|^(\d+)$/.exec(expr.trim());
    if (!m) return undefined;
    if (m[3] !== undefined) return Number(m[3]);
    const n = Number(m[2]);
    switch (m[1]) {
      case "fp":
        return n * FIXED_POINT_SCALE;
      case "fpMilli":
        return Math.trunc((n * FIXED_POINT_SCALE) / 1000);
      case "seconds":
        return n * 1000;
      default:
        return n;
    }
  };

  it("every key listed as per-type-overridable exists in the registry and is numeric", () => {
    for (const key of TUNABLES.PER_TYPE_OVERRIDABLE_DEFAULTS) {
      expect(typeof (TUNABLES as Record<string, unknown>)[key], key).toBe("number");
    }
  });

  it("traps.ts authors no effect literal at all — every effect value is a TUNABLES reference", () => {
    const src = read("traps.ts");
    expect(src).not.toMatch(/\b(fpMilli|seconds|ms|fp)\(/);
    expect(src).toContain("TUNABLES.TRAP_SLOW_MAGNITUDE_DEFAULT");
    expect(src).toContain("TUNABLES.TRAP_SLOW_DURATION_DEFAULT");
    expect(src).toContain("TUNABLES.TRAP_ROOT_DURATION_DEFAULT");
  });

  it("a healer field equal to its registry default is written as the TUNABLES key, not the literal", () => {
    const src = read("units.ts");
    const defaults: Record<string, number> = {
      radius: TUNABLES.HEAL_RADIUS_DEFAULT,
      healFraction: TUNABLES.HEAL_FRACTION_DEFAULT,
      charges: TUNABLES.HEAL_CHARGES_PER_BATTLE,
      cooldown: TUNABLES.HEAL_COOLDOWN_DEFAULT,
    };
    const blocks = src.split('archetype: "heal_radius"').slice(1);
    expect(blocks).toHaveLength(LIVING_UNIT_TYPES.filter((u) => u.ability.archetype === "heal_radius").length);
    let referenced = 0;
    for (const block of blocks) {
      const body = block.slice(0, block.indexOf("}"));
      for (const m of body.matchAll(/(radius|healFraction|charges|cooldown):\s*([^,\n]+),/g)) {
        const [, field, expr] = m;
        const lit = authored(expr!);
        if (lit === undefined) {
          expect(expr, `${field}: ${expr}`).toMatch(/^TUNABLES\./);
          referenced++;
        } else {
          expect(lit, `healer ${field} re-authors the registry default as the literal '${expr}' — reference TUNABLES instead`).not.toBe(defaults[field!]);
        }
      }
    }
    expect(referenced).toBeGreaterThan(0);
  });
});

describe("ability descriptions agree with the data (QA N3)", () => {
  const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const fixedStr = (v: number) => String(Number((v / FIXED_POINT_SCALE).toFixed(2)));
  const pctStr = (v: number) => String(Math.round((v / FIXED_POINT_SCALE) * 100));
  const secStr = (v: number) => String(Number((v / 1000).toFixed(2)));

  it("every digit in a description is one of that ability's authored values, and healers state their charges", () => {
    for (const u of LIVING_UNIT_TYPES) {
      const a = u.ability as unknown as Record<string, number | string>;
      const allowed = new Set<string>();
      for (const [k, v] of Object.entries(a)) {
        if (typeof v !== "number") continue;
        if (k === "charges") allowed.add(String(v));
        else if (k === "cooldown" || k === "duration") allowed.add(secStr(v));
        else if (k === "healFraction" || k === "damageBonus") allowed.add(pctStr(v));
        else allowed.add(fixedStr(v)); // radius, distance, damageMult, fenceDamageMult
      }
      allowed.add(secStr(abilityFirstUseMs(u.ability))); // QA-12 S5: the first-use line
      // Digits are stat claims and must match the data exactly. Spelled-out numbers are
      // prose ("One aimed round", "a two-handed swing") except the healer charge count,
      // which is checked below.
      const digits = [...u.ability.description.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
      expect(digits.length, `${u.id}: description carries no number at all`).toBeGreaterThan(0);
      for (const t of digits) expect(allowed, `${u.id} '${u.ability.description}': ${t} is not in ${[...allowed].join(", ")}`).toContain(t);
      if (u.ability.archetype === "heal_radius") {
        const charges = u.ability.charges;
        const word = Object.entries(WORDS).find(([, n]) => n === charges)?.[0];
        const says = new RegExp(`\\b(${charges}|${word})\\b`, "i");
        expect(u.ability.description, `${u.id}: healer description must state its ${charges} charges`).toMatch(says);
      }
    }
  });

  it("chunk 12 QA D1: every structure breaker states the per-tick fence-hit rule exactly, and 'half' matches FENCE_HIT_SEGMENT_CAP (×0.50); no description claims 'never one-shot' any more", () => {
    expect(TUNABLES.FENCE_HIT_SEGMENT_CAP).toBe(512);
    expect("STRUCTURE_BREAKER_SEGMENT_CAP" in TUNABLES).toBe(false);
    const breakers = LIVING_UNIT_TYPES.filter((u) => u.ability.archetype === "structure_breaker");
    expect(breakers.length).toBe(6);
    for (const u of breakers) expect(u.ability.description, u.id).toMatch(/; with its normal hit it takes at most half a segment's max HP per tick\./);
    for (const u of LIVING_UNIT_TYPES) expect(u.ability.description, u.id).not.toMatch(/one blow|one-shot/);
  });

  it("chunk 12 QA S5: every description ends with its first-use line, on the resolver's tick grid (breakers ×0.25, everything else ×1.0)", () => {
    expect(TUNABLES.STRUCTURE_BREAKER_FIRST_USE_MULT).toBe(256);
    expect(TUNABLES.ABILITY_FIRST_USE_DELAY_MULT).toBe(1024);
    for (const u of LIVING_UNIT_TYPES) {
      const first = abilityFirstUseMs(u.ability);
      const ticks = Math.max(1, Math.floor((u.ability.cooldown * TUNABLES.TICK_RATE) / 1000));
      const mult = u.ability.archetype === "structure_breaker" ? TUNABLES.STRUCTURE_BREAKER_FIRST_USE_MULT : TUNABLES.ABILITY_FIRST_USE_DELAY_MULT;
      expect(first, u.id).toBe((Math.floor((ticks * mult) / FIXED_POINT_SCALE) * 1000) / TUNABLES.TICK_RATE);
      expect(u.ability.description.endsWith(` First use after ${secStr(first)} s.`), `${u.id}: '${u.ability.description}'`).toBe(true);
      expect(abilityDisplay(u.ability, u.attackRange).firstUseSeconds).toBe(secStr(first));
    }
    // A 12 s breaker swings first at 3 s; a 9 s dash at 9 s.
    expect(abilityFirstUseMs(LIVING_UNIT_TYPES.find((u) => u.id === "desert.well_digger")!.ability)).toBe(3000);
    expect(abilityFirstUseMs(LIVING_UNIT_TYPES.find((u) => u.id === "desert.dust_rider")!.ability)).toBe(9000);
  });

  it("chunk 12 QA S5: every healer states the heal ceiling — never above the HP it started this fight with", () => {
    const healers = LIVING_UNIT_TYPES.filter((u) => u.ability.archetype === "heal_radius");
    expect(healers.length).toBe(4);
    for (const u of healers) {
      expect(u.ability.description, u.id).toMatch(/never above the HP it started this fight with/);
      expect(abilityDisplay(u.ability, u.attackRange).healCeiling).toBe("start_of_fight_hp");
    }
  });
});

describe("chunk 12 QA S5: abilityDisplay gives display-ready numbers that render exactly", () => {
  const exact = (v: number, d: number): number => v / d;

  it("percentages are whole percents within 0.1 point of the stored value, and agree with the descriptions (10%, +35%)", () => {
    for (const u of LIVING_UNIT_TYPES) {
      const d = abilityDisplay(u.ability, u.attackRange);
      const a = u.ability;
      if (a.archetype === "heal_radius") {
        expect(Math.abs(Number(d.healPercent) - exact(a.healFraction * 100, FIXED_POINT_SCALE)), u.id).toBeLessThan(0.1);
        expect(a.description, u.id).toContain(`Restores ${d.healPercent}% max HP`);
        expect(d.charges).toBe(a.charges);
      } else expect(d.healPercent).toBeNull();
      if (a.archetype === "self_buff") {
        expect(Math.abs(Number(d.buffPercent) - exact(a.damageBonus * 100, FIXED_POINT_SCALE)), u.id).toBeLessThan(0.1);
        expect(a.description, u.id).toContain(`+${d.buffPercent}% damage for ${d.buffSeconds} seconds`);
      } else expect(d.buffPercent).toBeNull();
      for (const v of Object.values(d)) if (typeof v === "string" && v !== d.archetype && v !== d.healCeiling) expect(v, u.id).toMatch(/^\d+(\.\d{1,2})?$/);
    }
    const carrier = abilityDisplay(LIVING_UNIT_TYPES.find((u) => u.id === "desert.canteen_carrier")!.ability, 0 as Fixed);
    expect(carrier.healPercent).toBe("10"); // stored 102/1024 = 9.96 %
  });

  it("reachCells is radius + UNIT_RADIUS (burst, heal) or attack range + UNIT_RADIUS (strike, buff), centre to centre; null for dash and breaker", () => {
    for (const u of LIVING_UNIT_TYPES) {
      const a = u.ability;
      const d = abilityDisplay(a, u.attackRange);
      const r = a.archetype === "burst_radius" || a.archetype === "heal_radius" ? a.radius : a.archetype === "heavy_strike" || a.archetype === "self_buff" ? u.attackRange : null;
      if (r === null) expect(d.reachCells, u.id).toBeNull();
      else expect(Math.abs(Number(d.reachCells) - exact(r + TUNABLES.UNIT_RADIUS, FIXED_POINT_SCALE)), u.id).toBeLessThanOrEqual(0.005);
    }
    expect(abilityDisplay(LIVING_UNIT_TYPES.find((u) => u.id === "desert.canteen_carrier")!.ability, 0 as Fixed).reachCells).toBe("2.85");
  });

  it("the breaker's display carries the per-tick fence-hit cap as a percent", () => {
    for (const u of LIVING_UNIT_TYPES.filter((x) => x.ability.archetype === "structure_breaker")) expect(abilityDisplay(u.ability, u.attackRange).fenceHitCapPercent).toBe("50");
  });
});
