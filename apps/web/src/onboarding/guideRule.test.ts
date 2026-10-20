/**
 * Final play-test review round 3 S1: the guide's pick and advice as pure functions. These pin the
 * rule the balance harness runs too (packages/circle/src/guide.ts copies it rule for rule).
 */
import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { circleHurt, guidePick, isRangedHeavy, isRangedOnly, pushAdvice, rangedCount, type ScoutPartyLike, type StakesLike } from "./guideRule.ts";

const M = TUNABLES.ATTACK_RANGE_MELEE_DEFAULT;
const party = (hp: number[], range: number[], siege = 0): ScoutPartyLike => ({ units: hp.map((h, i) => ({ hp: h, attackRange: range[i]! })), siege: Array.from({ length: siege }, () => ({})) });
const gunslingers = party([380, 380, 640, 640], [M * 3.5, M * 3.5, M * 4, M * 4]); // Rattler Den Gang's shape
const brawlers = party([1100, 620, 1100, 620], [M, M, M, M]);
const mixed = party([1300, 450, 1300], [Math.round(M * 1.2), M * 4, M]);

const stakes = (over: Partial<StakesLike> = {}): StakesLike => ({
  units: [
    { ref: "a", alive: true, hp: 1100, maxHp: 1100 },
    { ref: "b", alive: true, hp: 620, maxHp: 620 },
  ],
  traps: { remaining: [{}], spent: [] },
  fences: { intact: [{}, {}], destroyed: [] },
  ...over,
});

describe("guideRule (round 3 S1)", () => {
  it("counts ranged raiders at GUIDE_RANGED_MIN_CELLS; a long arm is not a gun", () => {
    expect(rangedCount(gunslingers)).toEqual({ ranged: 4, total: 4 });
    expect(rangedCount(mixed)).toEqual({ ranged: 1, total: 3 });
    expect(isRangedOnly(gunslingers)).toBe(true);
    expect(isRangedOnly(mixed)).toBe(false);
    expect(isRangedHeavy(party([500, 500], [M * 4, M]))).toBe(true);
    expect(isRangedHeavy(mixed)).toBe(false);
    expect(isRangedOnly(party([], []))).toBe(false);
    expect(isRangedHeavy(party([], []))).toBe(false);
  });

  it("the pick passes over ranged-only parties, then takes the smallest (HP, siege, raiders, menu order), and names what it passed over", () => {
    const p = guidePick([gunslingers, brawlers, mixed])!;
    expect(p.index).toBe(2);
    expect(p.passedOver).toEqual([0]);
    expect(guidePick([gunslingers, brawlers])!.index).toBe(1);
    // Only ranged-only parties: the smallest of them, and nothing is passed over.
    const all = guidePick([party([900, 900], [M * 4, M * 4]), gunslingers])!;
    expect(all.index).toBe(0);
    expect(all.passedOver).toEqual([]);
    expect(guidePick([party([500, 500], [M, M], 2), party([500, 500], [M, M], 1)])!.index).toBe(1);
    expect(guidePick([])).toBeNull();
  });

  it("a circle is hurt by any loss: carried damage, a death, a spent trap or a broken segment", () => {
    expect(circleHurt(stakes())).toBe(false);
    expect(circleHurt(stakes({ units: [{ ref: "a", alive: true, hp: 1000, maxHp: 1100 }] }))).toBe(true);
    expect(circleHurt(stakes({ units: [{ ref: "a", alive: false, hp: 0, maxHp: 1100 }] }))).toBe(true);
    expect(circleHurt(stakes({ traps: { remaining: [], spent: [{}] } }))).toBe(true);
    expect(circleHurt(stakes({ fences: { intact: [{}], destroyed: [{}] } }))).toBe(true);
  });

  it("never advises a push when the circle is hurt and every party just offered is ranged-heavy", () => {
    const scratched = stakes({ traps: { remaining: [], spent: [{}] } });
    expect(pushAdvice(scratched, [gunslingers, party([500, 500], [M * 4, M])])).toEqual({ kind: "bank", reasons: [{ kind: "ranged_menu", parties: 2 }] });
    // One party that fights up close keeps the ordinary advice.
    expect(pushAdvice(scratched, [gunslingers, brawlers]).kind).toBe("push");
    // An unhurt circle keeps it too, and so does a missing menu.
    expect(pushAdvice(stakes(), [gunslingers]).kind).toBe("push");
    expect(pushAdvice(scratched, null).kind).toBe("push");
    expect(pushAdvice(scratched, []).kind).toBe("push");
  });

  it("keeps the D2 reasons: a survivor under half HP, none standing, no trap with more fence broken than stands", () => {
    expect(pushAdvice(stakes({ units: [{ ref: "a", alive: true, hp: 74, maxHp: 1100 }] }))).toEqual({ kind: "bank", reasons: [{ kind: "hurt", ref: "a", hp: 74, maxHp: 1100 }] });
    expect(pushAdvice(stakes({ units: [{ ref: "a", alive: false, hp: 0, maxHp: 1100 }] })).kind).toBe("bank");
    const broken = pushAdvice(stakes({ traps: { remaining: [], spent: [{}] }, fences: { intact: [{}], destroyed: [{}, {}] } }));
    expect(broken).toEqual({ kind: "bank", reasons: [{ kind: "no_trap" }, { kind: "fence", destroyed: 2, intact: 1 }] });
  });
});
