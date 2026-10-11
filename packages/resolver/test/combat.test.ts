/**
 * Chunk 11 — damage: the formula and its slot rule, the affinity layer (all nine pairs),
 * the rounding order, minimum damage, the merge rule (output scales, ratings don't),
 * cooldown pacing, the REACH boundary, target tie-break, simultaneity (mutual kills, HP to
 * exactly zero), death resolution, siege as a fence counter, and that affinity does real
 * work against raw stats.
 */
import { describe, expect, it } from "vitest";
import {
  AFFINITY_CATEGORIES,
  attackPhase,
  cellCenter,
  deathPhase,
  fenceHitDamage,
  formulaDamage,
  hitDamage,
  initialState,
  nearestEnemyInReach,
  normalizeInput,
  resolve,
  scaleInt,
  type AffinityCategory,
  type Fixed,
  type LogEvent,
  type ResolveInput,
  type SimState,
} from "../src/index.js";
import { DEFAULT_TUNABLES, QUIET_SHORT_TUNABLES, SHORT_TUNABLES, quiet, battlefield, clone, fence, fx, input, ms, party, post, reachSq, ringExcept, unit } from "./fixtures.js";

const events = <K extends LogEvent["k"]>(out: { readonly log: readonly LogEvent[] }, k: K) => out.log.filter((e): e is Extract<LogEvent, { k: K }> => e.k === k);
const mk = (inp: ResolveInput): SimState => initialState(normalizeInput(clone(inp)));
const place = (state: SimState, id: number, x: number, y: number): void => {
  state.units[id]!.x = x as Fixed;
  state.units[id]!.y = y as Fixed;
};
/** A hold post at (15,8): centre (15872, 8704). */
const holdPost = () => post("p", { x: 15, y: 8 }, { stance: "hold" });
const POST_X = 15 * 1024 + 512;
const POST_Y = 8 * 1024 + 512;

describe("DAMAGE_FORMULA and DAMAGE_SLOTS", () => {
  it("hit = floor(o² / (o + d)), rounded down", () => {
    expect(formulaDamage(95, 100)).toBe(46); // 9025 / 195 = 46.28
    expect(formulaDamage(100, 100)).toBe(50);
    expect(formulaDamage(100, 0)).toBe(100); // a fence: no rating
    expect(formulaDamage(40, 120)).toBe(10);
  });

  it("an attacker deals with its OFFENSE against the post's DEFENSE; a posted unit deals with its DEFENSE against the attacker's OFFENSE", () => {
    // Attacker: beast, offense 95. Post: grit, defense 100. Beast beats grit.
    const state = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a" })])));
    const a = state.units[0]!;
    const p = state.units[1]!;
    expect(a.rating).toBe(95);
    expect(p.rating).toBe(100);
    // attacker → post: floor(95²/(95+100)) = 46, × 1.25 (advantage) = 57.5 → 57
    expect(hitDamage(state, a, p)).toBe(57);
    // post → attacker: floor(100²/(100+95)) = 51, × 0.80 (819/1024, disadvantage) = 40.79 → 40
    expect(hitDamage(state, p, a)).toBe(40);
    // Hand-check that it is the post's DEFENSE driving its output: with offense in that slot it would be 0 → clamped to 1.
    expect(p.offense).toBe(0);
    expect(a.defense).toBe(0);
    expect(formulaDamage(p.defense, a.offense)).toBe(51);
  });

  it("applies the affinity matrix from the input to all nine dealer/receiver pairs, with the fixed rounding point", () => {
    const state = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a" })])));
    const a = state.units[0]!;
    const p = state.units[1]!;
    const expected: Record<AffinityCategory, Record<AffinityCategory, number>> = {
      // base = floor(95²/195) = 46; advantage 46 × 1280/1024 = 57.5 → 57; disadvantage 46 × 819/1024 = 36.79 → 36
      grit: { grit: 46, powder: 57, beast: 36 },
      powder: { grit: 36, powder: 46, beast: 57 },
      beast: { grit: 57, powder: 36, beast: 46 },
    };
    for (const dealer of AFFINITY_CATEGORIES) {
      for (const receiver of AFFINITY_CATEGORIES) {
        const d = { ...a, affinity: dealer };
        const r = { ...p, affinity: receiver };
        expect(hitDamage(state, d, r), `${dealer} → ${receiver}`).toBe(expected[dealer][receiver]);
      }
    }
    // The matrix is INPUT: flip one relationship and the number follows it.
    const flipped = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a" })]), { ...DEFAULT_TUNABLES, affinityMatrix: { ...DEFAULT_TUNABLES.affinityMatrix, beast: { grit: "disadvantage", powder: "advantage", beast: "neutral" } } }));
    expect(hitDamage(flipped, flipped.units[0]!, flipped.units[1]!)).toBe(36);
    // And the multipliers are input too.
    const doubled = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a" })]), { ...DEFAULT_TUNABLES, affinityAdvantageMult: 2048 as Fixed }));
    expect(hitDamage(doubled, doubled.units[0]!, doubled.units[1]!)).toBe(92);
  });

  it("DAMAGE_MINIMUM: a hit that rounds to 0 lands for 1 — a 1-rating unit against a 1 000 000-rating one, and a disadvantaged 1", () => {
    const state = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a", offense: 1 })])));
    const weak = state.units[0]!;
    const strong = { ...state.units[1]!, rating: 1_000_000, defense: 1_000_000 };
    expect(formulaDamage(1, 1_000_000)).toBe(0);
    expect(hitDamage(state, weak, strong)).toBe(1);
    // 1 × 0.80 floors to 0 → 1.
    expect(hitDamage(state, { ...weak, affinity: "powder" }, { ...strong, rating: 0, affinity: "grit" })).toBe(1);
  });
});

describe("MERGE rule (chunk 03 QA B1)", () => {
  it("the merge multiplier scales each hit's OUTPUT (after the formula and affinity) and never the ratings; abilities untouched", () => {
    const at = (level: number) => mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a", mergeLevel: level })])));
    const l1 = at(1);
    const l3 = at(3);
    const l5 = at(5);
    expect(l1.units[0]!.rating).toBe(95);
    expect(l3.units[0]!.rating).toBe(95);
    expect(l5.units[0]!.rating).toBe(95);
    expect(l3.units[0]!.mergeMult).toBe(1600);
    expect(hitDamage(l1, l1.units[0]!, l1.units[1]!)).toBe(57);
    expect(hitDamage(l3, l3.units[0]!, l3.units[1]!)).toBe(scaleInt(57, 1600 as Fixed)); // 89
    expect(hitDamage(l5, l5.units[0]!, l5.units[1]!)).toBe(scaleInt(57, 2500 as Fixed)); // 139
    // Linear in the table, not in the rating: a scaled-rating version would give floor(148²/248) = 88, not 89.
    expect(hitDamage(l3, l3.units[0]!, l3.units[1]!)).toBe(89);
    expect(Math.floor((148 * 148) / (148 + 100))).toBe(88);
    // The receiver's merge level changes nothing about the hit it takes (its merge is in its maxHp, in the input).
    const p3 = mk(input(battlefield({ posts: [post("p", { x: 15, y: 8 }, { stance: "hold", mergeLevel: 3 })] }), party([unit({ ref: "a" })])));
    expect(p3.units[1]!.rating).toBe(100);
    expect(hitDamage(p3, p3.units[0]!, p3.units[1]!)).toBe(57);
    expect(hitDamage(p3, p3.units[1]!, p3.units[0]!)).toBe(scaleInt(40, 1600 as Fixed));
    expect(l5.units[0]!.ability).toEqual(l1.units[0]!.ability);
    // A fence hit is a hit: merge scales it too (and the breach price follows).
    const f = mk(input(battlefield({ fences: [fence({ segment: 3 })] }), party([unit({ ref: "a", mergeLevel: 3 })])));
    expect(fenceHitDamage(f, f.units[0]!, f.fences[0]!)).toBe(scaleInt(95, 1600 as Fixed)); // 148
  });

  it("the table is input: a unit whose merge level has no entry is refused", () => {
    expect(() => resolve(input(battlefield(), party([unit({ ref: "a", mergeLevel: 6 })])))).toThrow(/mergeLevel 6 has no entry/);
    expect(() => resolve(input(battlefield({ posts: [post("p", { x: 15, y: 8 }, { mergeLevel: 6 })] }), party([unit({ ref: "a" })])))).toThrow(/posts\[0\]\.mergeLevel 6/);
  });
});

describe("ATTACK_COOLDOWN, REACH and ATTACK_TARGET_SELECTION", () => {
  it("fires on contact and then every cooldownTicks, one hit per unit per tick, logging attacker, target, damage and HP after", () => {
    const out = resolve(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    const mine = events(out, "hit").filter((h) => h.u === 0);
    expect(mine.length).toBeGreaterThan(5);
    expect(mine[0]!.v).toBe(1);
    expect(mine[0]!.damage).toBe(57);
    expect(mine[0]!.hp).toBe(1100 - 57);
    for (let i = 1; i < mine.length; i++) expect(mine[i]!.t - mine[i - 1]!.t).toBe(20); // 1000 ms at 20 ticks/s
    // The post (1400 ms → 28 ticks) answers on its own cadence, first on the same tick it is reached.
    const theirs = events(out, "hit").filter((h) => h.u === 1);
    expect(theirs[0]!.t).toBe(mine[0]!.t);
    for (let i = 1; i < theirs.length; i++) expect(theirs[i]!.t - theirs[i - 1]!.t).toBe(28);
    expect(theirs[0]!.damage).toBe(40);
  });

  it("REACH: a target at exactly attackRange + unitRadius is hit; one fixed unit further is not", () => {
    const at = (dist: number) => {
      const state = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a" })])));
      place(state, 0, POST_X, POST_Y - dist);
      const log: LogEvent[] = [];
      attackPhase(state, log);
      return log.filter((e) => e.k === "hit");
    };
    expect(reachSq(1024)).toBe(1382 * 1382);
    expect(at(1382)).toHaveLength(2); // both in reach of each other: a hits p, p hits a
    expect(at(1383)).toHaveLength(0);
    // The reach follows unitRadius from the input.
    const state = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a" })]), { ...DEFAULT_TUNABLES, unitRadius: 0 as Fixed }));
    place(state, 0, POST_X, POST_Y - 1025);
    const log: LogEvent[] = [];
    attackPhase(state, log);
    expect(log).toHaveLength(0);
    place(state, 0, POST_X, POST_Y - 1024);
    attackPhase(state, log);
    expect(log.filter((e) => e.k === "hit")).toHaveLength(2);
  });

  it("hits the NEAREST enemy in reach regardless of its movement target; an exact tie goes to the lower id", () => {
    // Two hold posts equidistant from the attacker, both in reach; p1 has the lower id.
    const state = mk(input(battlefield({ posts: [post("p2", { x: 16, y: 8 }, { stance: "hold" }), post("p1", { x: 14, y: 8 }, { stance: "hold" })] }), party([unit({ ref: "a", stance: "core" })])));
    place(state, 0, POST_X, POST_Y);
    expect(nearestEnemyInReach(state, state.units[0]!)!.ref).toBe("p1");
    state.units[0]!.target = { kind: "core" }; // a `core` attacker still fires at what is in reach
    const log: LogEvent[] = [];
    attackPhase(state, log);
    expect(log.filter((e) => e.k === "hit" && e.u === 0).map((e) => (e as { v: number }).v)).toEqual([1]);
    // Move p2 one unit closer: it wins.
    state.units[2]!.x = (state.units[2]!.x - 1) as Fixed;
    expect(nearestEnemyInReach(state, state.units[0]!)!.ref).toBe("p2");
  });

  it("ATTACK_PRIORITY (QA-11 D2): a breacher switches from the fence only to a unit that can reach it back", () => {
    // Sealed 100-HP ring: a 40-offense unit needs 3 hits on segment 3 (cell (15,11)) from (15,10).
    const noPost = resolve(input(battlefield({ fences: ringExcept([], 100) }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, offense: 40 })]), QUIET_SHORT_TUNABLES));
    expect(events(noPost, "fence_hit")).toHaveLength(3);
    // A 13-HP hold post two cells behind the segment, at (15,12): out of a melee breacher's reach
    // (2 cells > 1.35), so the fence goes first and the post is hit only once the unit is through…
    const melee = resolve(input(battlefield({ fences: ringExcept([], 100), posts: [post("p", { x: 15, y: 12 }, { stance: "hold", hp: 13, maxHp: 40 })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, offense: 40 })]), QUIET_SHORT_TUNABLES));
    expect(events(melee, "fence_hit")).toHaveLength(3);
    expect(events(melee, "hit").find((h) => h.u === 0)!.t).toBeGreaterThan(events(melee, "fence_broken")[0]!.t);
    // … a ranged breacher (4 cells) with a MELEE post in its reach: the post cannot touch it
    // (2 cells > the post's 1.35), so it is no threat and does not shield the fence — the
    // breach runs exactly as with no post and is not interrupted (shots on the approach, before
    // it stands at the fence, are the plain nearest-in-reach rule).
    const shooter = { ref: "a", cell: { x: 15, y: 0 }, offense: 40, attackRange: fx(4096) } as const;
    const ranged0 = resolve(input(battlefield({ fences: ringExcept([], 100) }), party([unit(shooter)]), QUIET_SHORT_TUNABLES));
    const harmless = resolve(input(battlefield({ fences: ringExcept([], 100), posts: [post("p", { x: 15, y: 12 }, { stance: "hold", hp: 13, maxHp: 40 })] }), party([unit(shooter)]), QUIET_SHORT_TUNABLES));
    expect(events(harmless, "fence_hit").map((e) => e.t)).toEqual(events(ranged0, "fence_hit").map((e) => e.t));
    const breachFrom = events(harmless, "fence_hit")[0]!.t;
    const breachTo = events(harmless, "fence_broken")[0]!.t;
    expect(events(harmless, "hit").filter((h) => h.u === 0 && h.t >= breachFrom && h.t <= breachTo)).toEqual([]);
    // … a ranged breacher with a RANGED post (4 cells) that does reach it: it fights back first
    // (one 13-damage hit kills the post), THEN the fence.
    const ranged = resolve(input(battlefield({ fences: ringExcept([], 100), posts: [post("p", { x: 15, y: 12 }, { stance: "hold", hp: 13, maxHp: 40, attackRange: fx(4096) })] }), party([unit(shooter)]), QUIET_SHORT_TUNABLES));
    const firstHit = events(ranged, "hit").find((h) => h.u === 0)!;
    const firstFence = events(ranged, "fence_hit")[0]!;
    expect(firstHit).toMatchObject({ v: 1, damage: 13, hp: 0 });
    expect(firstHit.t).toBeLessThan(firstFence.t);
    expect(firstFence.t - firstHit.t).toBeGreaterThanOrEqual(20); // the shot spent the cooldown
    expect(ranged.units[1]!.alive).toBe(false);
    expect(events(ranged, "fence_broken")).toHaveLength(1);
    // Pinned directly, at the exact boundary of the post's reach: a breacher with a ready
    // cooldown hits the post when the post's reach covers it, the fence when it is one unit short.
    for (const [postRange, expectFence] of [[fx(2048 - 358), 0], [fx(2048 - 358 - 1), 1]] as const) {
      // post at (15,12) centre, breacher at (15,10) centre: 2048 apart; post reach = range + unitRadius.
      const state = mk(input(battlefield({ fences: ringExcept([], 100), posts: [post("p", { x: 15, y: 12 }, { stance: "hold", attackRange: postRange })] }), party([unit({ ...shooter })])));
      place(state, 0, 15 * 1024 + 512, 10 * 1024 + 512);
      state.units[0]!.breaching = 3;
      const log: LogEvent[] = [];
      attackPhase(state, log);
      expect(log.filter((e) => e.k === "fence_hit")).toHaveLength(expectFence);
      expect(log.filter((e) => e.k === "hit" && e.u === 0)).toHaveLength(1 - expectFence);
    }
    // A non-breaching attacker keeps the plain nearest-in-reach rule: it shoots the harmless post.
    const state = mk(input(battlefield({ posts: [post("p", { x: 15, y: 12 }, { stance: "hold" })] }), party([unit({ ...shooter })])));
    place(state, 0, 15 * 1024 + 512, 10 * 1024 + 512);
    const log: LogEvent[] = [];
    attackPhase(state, log);
    expect(log.filter((e) => e.k === "hit" && e.u === 0)).toHaveLength(1);
  });
});

describe("SIMULTANEOUS_DAMAGE and death resolution", () => {
  it("mutual kill: two units that each reduce the other to 0 on the same tick both die on that tick, in id order", () => {
    const state = mk(input(battlefield({ posts: [post("p", { x: 15, y: 8 }, { stance: "hold", hp: 57, maxHp: 1100 })] }), party([unit({ ref: "a", hp: 40 })])));
    place(state, 0, POST_X, POST_Y - 1000);
    const log: LogEvent[] = [];
    attackPhase(state, log);
    expect(log).toEqual([
      { t: 0, k: "hit", u: 0, v: 1, damage: 57, hp: 0 },
      { t: 0, k: "hit", u: 1, v: 0, damage: 40, hp: 0 }, // fired at 0 HP: still alive until phase 8
    ]);
    expect(state.units.every((u) => u.alive)).toBe(true);
    deathPhase(state, log);
    expect(log.slice(2)).toEqual([
      { t: 0, k: "unit_died", u: 0 },
      { t: 0, k: "unit_died", u: 1 },
    ]);
    expect(state.units.map((u) => [u.alive, u.hp, u.diedTick])).toEqual([
      [false, 0, 0],
      [false, 0, 0],
    ]);
  });

  it("HP reduced to exactly zero dies; HP never goes below zero; a dead unit is out of targeting and takes no further hit", () => {
    const state = mk(input(battlefield({ posts: [post("p", { x: 15, y: 8 }, { stance: "hold", hp: 57, maxHp: 1100 }), post("q", { x: 15, y: 5 }, { stance: "hold" })] }), party([unit({ ref: "a", hp: 2000 })])));
    place(state, 0, POST_X, POST_Y - 1000);
    const log: LogEvent[] = [];
    attackPhase(state, log);
    deathPhase(state, log);
    expect(state.units[1]!.hp).toBe(0);
    expect(state.units[1]!.alive).toBe(false);
    // Overkill floors at 0.
    const over = mk(input(battlefield({ posts: [post("p", { x: 15, y: 8 }, { stance: "hold", hp: 10, maxHp: 1100 })] }), party([unit({ ref: "a" })])));
    place(over, 0, POST_X, POST_Y - 1000);
    attackPhase(over, []);
    expect(over.units[1]!.hp).toBe(0);
    // Next tick: the attacker is ready again only after its cooldown; the dead post is skipped, q (3 cells away) is out of reach.
    state.units[0]!.cooldownRemaining = 0;
    const log2: LogEvent[] = [];
    attackPhase(state, log2);
    expect(log2).toEqual([]);
    expect(nearestEnemyInReach(state, state.units[0]!)).toBeNull();
  });

  it("a unit killed by a trap on tick t still fires in phase 6 of tick t, then dies in phase 8", () => {
    const state = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a", hp: 5 })])));
    place(state, 0, POST_X, POST_Y - 1000);
    state.units[0]!.hp = 0; // as a trap in phase 4 would leave it
    const log: LogEvent[] = [];
    attackPhase(state, log);
    expect(log.some((e) => e.k === "hit" && e.u === 0)).toBe(true);
    deathPhase(state, log);
    expect(state.units[0]!.alive).toBe(false);
  });

  it("end to end: the attacker kills the hold post, the log carries every hit, the summary carries diedTick, and the loop keeps running (endOfTick is still a seam)", () => {
    const out = resolve(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 }, hp: 5000 })]), SHORT_TUNABLES));
    const died = events(out, "unit_died");
    expect(died).toEqual([{ t: out.units[1]!.diedTick, k: "unit_died", u: 1 }]);
    expect(out.units[1]!.alive).toBe(false);
    expect(out.units[1]!.hp).toBe(0);
    const hits = events(out, "hit").filter((h) => h.u === 0);
    expect(hits).toHaveLength(20); // ⌈1100 / 57⌉
    expect(hits[hits.length - 1]!.hp).toBe(0);
    expect(hits[hits.length - 1]!.t).toBe(out.units[1]!.diedTick);
    expect(events(out, "hit").filter((h) => h.t > out.units[1]!.diedTick)).toHaveLength(0);
    expect(out.ticks).toBe(600);
    expect(out.end).toBe("tick_cap");
    // The attacker retargets to the core the tick after and reaches it.
    expect(events(out, "target").map((e) => e.target?.kind)).toEqual(["unit", "core"]);
    expect(out.units[0]!.reachedCoreTick).toBeGreaterThan(out.units[1]!.diedTick);
  });
});

describe("siege is a counter to fences, never a buff", () => {
  it("×4 on hits against the countered fence category only; a mismatched category and a trap-counter piece change nothing", () => {
    const run = (counters: { kind: "fence" | "trap"; category: string }[], category: "timber" | "wire" | "stone") =>
      mk(input(battlefield({ fences: [fence({ segment: 3, category })] }), party([unit({ ref: "a" })], counters.map((c, i) => ({ ref: `s${i}`, typeId: "siege.x", counters: c as never })))));
    const matched = run([{ kind: "fence", category: "timber" }], "timber");
    expect(matched.fences[0]!.siegeCountered).toBe(true);
    expect(fenceHitDamage(matched, matched.units[0]!, matched.fences[0]!)).toBe(380);
    const mismatched = run([{ kind: "fence", category: "timber" }], "stone");
    expect(fenceHitDamage(mismatched, mismatched.units[0]!, mismatched.fences[0]!)).toBe(95);
    const trapPiece = run([{ kind: "trap", category: "groundwork" }], "timber");
    expect(fenceHitDamage(trapPiece, trapPiece.units[0]!, trapPiece.fences[0]!)).toBe(95);
    const none = run([], "timber");
    expect(fenceHitDamage(none, none.units[0]!, none.fences[0]!)).toBe(95);
    // Unit hits are untouched by siege of any kind.
    const withPost = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a" })], [{ ref: "s", typeId: "siege.x", counters: { kind: "fence", category: "timber" } }])));
    expect(hitDamage(withPost, withPost.units[0]!, withPost.units[1]!)).toBe(57);
  });

  it("end to end: a battering wagon breaks a 300-HP timber segment in one hit instead of four, and the breach is priced accordingly", () => {
    const field = battlefield({ fences: [fence({ segment: 3, maxHp: 300 })] });
    const plain = resolve(input(field, party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    const siege = resolve(input(field, party([unit({ ref: "a", cell: { x: 15, y: 0 } })], [{ ref: "s", typeId: "siege.battering_wagon", counters: { kind: "fence", category: "timber" } }]), SHORT_TUNABLES));
    // Without siege the single segment is walked around; with it the one-hit breach is cheaper than the detour.
    expect(events(plain, "fence_hit")).toHaveLength(0);
    expect(events(siege, "fence_hit")).toEqual([{ t: events(siege, "fence_hit")[0]!.t, k: "fence_hit", u: 0, f: 0, damage: 380, hp: 0 }]);
    expect(siege.units[0]!.reachedCoreTick).toBeLessThanOrEqual(plain.units[0]!.reachedCoreTick);
  });
});

describe("affinity does real work", () => {
  it("a stat-inferior party with a favourable matchup beats a hold post that a stat-superior party with an unfavourable matchup loses to", () => {
    const guard = post("p", { x: 15, y: 8 }, { stance: "hold", defense: 100, hp: 1000, maxHp: 1000, affinity: "grit", attackCooldown: ms(1000) });
    const fight = (affinity: "beast" | "powder", offense: number, hp: number) => resolve(input(battlefield({ posts: [guard] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 }, affinity, offense, hp })]), quiet({ ...SHORT_TUNABLES, battleLengthCapSeconds: 120 })));
    // Beast beats grit: offense 90 / 900 HP wins (52 per hit vs 39 taken).
    const weaker = fight("beast", 90, 900);
    expect(weaker.units[1]!.alive).toBe(false);
    expect(weaker.units[0]!.alive).toBe(true);
    // Grit beats powder: offense 100 / 1000 HP loses (39 per hit vs 62 taken).
    const stronger = fight("powder", 100, 1000);
    expect(stronger.units[0]!.alive).toBe(false);
    expect(stronger.units[1]!.alive).toBe(true);
    expect(events(weaker, "hit")[0]!.damage).toBe(52);
    expect(events(stronger, "hit")[0]!.damage).toBe(39);
  });

  it("DPS sanity: a big slow hitter and a small fast hitter are comparably threatening", () => {
    const state = mk(input(battlefield({ posts: [holdPost()] }), party([unit({ ref: "a", offense: 120, attackCooldown: 2400 }), unit({ ref: "b", offense: 60, attackCooldown: 600 })])));
    const p = state.units[2]!;
    const big = hitDamage(state, state.units[0]!, p); // floor(120²/220) = 65 × 1.25 = 81
    const small = hitDamage(state, state.units[1]!, p); // floor(60²/160) = 22 × 1.25 = 27
    const dpsBig = (big * 1000) / 2400;
    const dpsSmall = (small * 1000) / 600;
    expect(big).toBe(81);
    expect(small).toBe(27);
    expect(dpsSmall / dpsBig).toBeGreaterThan(1);
    expect(dpsSmall / dpsBig).toBeLessThan(1.5); // the formula favours the big rating; the cooldown is a real lever
  });
});

describe("the cell centre is where posts stand", () => {
  it("fixture sanity", () => {
    expect(cellCenter({ x: 15, y: 8 })).toEqual({ x: POST_X, y: POST_Y });
  });
});
