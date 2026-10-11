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
  FENCE_CATEGORIES,
  FENCE_TIERS,
  FIXED_POINT_SCALE,
  LIVING_UNIT_TYPES,
  REGION_IDS,
  SIEGE_TYPES,
  TRAP_CATEGORIES,
  TRAP_TYPES,
  TUNABLES,
  affinityMult,
  mergeStatMult,
  unitsForRegion,
  validateContent,
  type AffinityCategory,
} from "../src/index.js";

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
    expect(validateContent(procChance).some((p) => p.includes("unexpected field 'procChance'"))).toBe(true);
  });
});

describe("merge curve is a slot-efficiency gain, never a power gain (GUARDRAILS §2)", () => {
  it("stays strictly below the components-combined line for every recipe at every level", () => {
    for (let level = TUNABLES.MERGE_LEVEL_MIN; level < TUNABLES.MERGE_LEVEL_MAX; level++) {
      const here = mergeStatMult(level);
      const next = mergeStatMult(level + 1);
      expect(next).toBeGreaterThan(here);
      for (const recipe of TUNABLES.MERGE_RECIPES) {
        // produce × S(L+1) < spend × S(L)
        expect(recipe.produce * next).toBeLessThan(recipe.spend * here);
      }
    }
  });

  it("per-level multiplier is below 2.0 (2→1) and below 5/3 (5→3)", () => {
    for (let level = TUNABLES.MERGE_LEVEL_MIN; level < TUNABLES.MERGE_LEVEL_MAX; level++) {
      const ratio = mergeStatMult(level + 1) / mergeStatMult(level);
      expect(ratio).toBeLessThan(2);
      expect(ratio).toBeLessThan(5 / 3);
      expect(ratio).toBeGreaterThan(1);
    }
    expect(mergeStatMult(1)).toBe(FIXED_POINT_SCALE);
    expect(() => mergeStatMult(0)).toThrow(RangeError);
    expect(() => mergeStatMult(6)).toThrow(RangeError);
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
    for (const k of keys) expect(k.toLowerCase()).not.toContain("tick");
    for (const k of Object.keys(TUNABLES)) expect(k.toUpperCase()).not.toContain("TICK");
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
