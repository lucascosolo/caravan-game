/**
 * The guide's shared rule (final play-test review r3 S1): the client's pick and bank-or-push advice,
 * which the balance harness runs as well. Pinned here so a change to it is a visible change to both.
 */
import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { GUIDE_RANGED_MIN_CELLS, applyEncounterOutcome, circleHurt, guidePick, guideStakesOf, isRangedHeavy, isRangedOnly, isRangedRaider, pushAdvice, rangedCount, type ScoutPartyLike, type StakesLike } from "../src/index.js";
import { fullPack } from "./fixtures.js";

const CELL = TUNABLES.ATTACK_RANGE_MELEE_DEFAULT;
const melee = (hp: number) => ({ attackRange: CELL, hp });
const gun = (hp: number) => ({ attackRange: GUIDE_RANGED_MIN_CELLS * CELL, hp });
const party = (units: ScoutPartyLike["units"], siege = 0): ScoutPartyLike => ({ units, siege: Array.from({ length: siege }, () => "s") });

describe("the guide's ranged reading", () => {
  it("a raider is ranged from GUIDE_RANGED_MIN_CELLS cells; only-ranged and ranged-heavy read off the counts", () => {
    expect(GUIDE_RANGED_MIN_CELLS).toBe(3);
    expect(isRangedRaider({ attackRange: 3 * CELL - 1 })).toBe(false);
    expect(isRangedRaider({ attackRange: 3 * CELL })).toBe(true);
    expect(rangedCount(party([gun(1), melee(1), melee(1)]))).toEqual({ ranged: 1, total: 3 });
    expect(isRangedOnly(party([gun(1), gun(1)]))).toBe(true);
    expect(isRangedOnly(party([]))).toBe(false);
    expect(isRangedHeavy(party([gun(1), melee(1)]))).toBe(true);
    expect(isRangedHeavy(party([gun(1), melee(1), melee(1)]))).toBe(false);
  });
});

describe("guidePick: pass over ranged-only parties, then the smallest", () => {
  it("least HP, then fewest siege, then fewest raiders, then menu order; ranged-only parties passed over while another exists", () => {
    expect(guidePick([])).toBeNull();
    const menu = [party([gun(100), gun(100)]), party([melee(300)], 1), party([melee(150), melee(150)]), party([melee(300)])];
    expect(guidePick(menu)).toEqual({ index: 3, raiders: 1, hp: 300, siege: 0, passedOver: [0] });
    // Every party ranged-only: the smallest of them, nothing passed over.
    expect(guidePick([party([gun(200)]), party([gun(100)])])).toMatchObject({ index: 1, passedOver: [] });
    // Ties fall to menu order.
    expect(guidePick([party([melee(5)]), party([melee(5)])])!.index).toBe(0);
  });
});

describe("pushAdvice", () => {
  const fresh = guideStakesOf(fullPack());
  it("guideStakesOf projects a survivors manifest the way the server's preview does", () => {
    const m = fullPack();
    expect(fresh.units).toEqual(m.units.map((u) => ({ ref: u.ref, alive: true, hp: u.maxHp, maxHp: u.maxHp })));
    expect(fresh.traps.spent).toEqual([]);
    expect(fresh.fences.destroyed).toEqual([]);
    expect(circleHurt(fresh)).toBe(false);
  });

  it("a whole circle is advised to push whatever the menu; a hurt one banks when every candidate is ranged-heavy", () => {
    const ranged = [party([gun(1), melee(1)]), party([gun(1)])];
    expect(pushAdvice(fresh, ranged)).toEqual({ kind: "push" });
    const m = fullPack();
    const scratched = guideStakesOf(applyEncounterOutcome(m, { units: [{ ref: m.units[0]!.ref, hp: m.units[0]!.maxHp - 1 }], spentTraps: [], fences: [] }));
    expect(circleHurt(scratched)).toBe(true);
    expect(pushAdvice(scratched, null)).toEqual({ kind: "push" });
    expect(pushAdvice(scratched, [...ranged, party([melee(1), melee(1), gun(1)])])).toEqual({ kind: "push" });
    expect(pushAdvice(scratched, ranged)).toEqual({ kind: "bank", reasons: [{ kind: "ranged_menu", parties: 2 }] });
  });

  it("banks when a standing unit is under half its HP, or none stands", () => {
    const p: StakesLike = { units: [{ ref: "a", alive: true, hp: 4, maxHp: 10 }], traps: { remaining: [], spent: [] }, fences: { intact: [], destroyed: [] } };
    expect(pushAdvice(p)).toEqual({ kind: "bank", reasons: [{ kind: "hurt", ref: "a", hp: 4, maxHp: 10 }] });
    expect(pushAdvice({ ...p, units: [{ ref: "a", alive: false, hp: 0, maxHp: 10 }] })).toEqual({ kind: "bank", reasons: [{ kind: "none_standing" }] });
  });

  it("round 4 D1: from encounter 2, pushes only an unhurt circle against a menu that is not ranged-heavy", () => {
    const ranged = [party([gun(1), melee(1)]), party([gun(1)])];
    const mixed = [...ranged, party([melee(1), melee(1), gun(1)])];
    const m = fullPack();
    const scratched = guideStakesOf(applyEncounterOutcome(m, { units: [{ ref: m.units[0]!.ref, hp: m.units[0]!.maxHp - 1 }], spentTraps: [], fences: [] }));
    // Encounter 1 is unchanged (the default index is 1).
    expect(pushAdvice(scratched, mixed, 1)).toEqual({ kind: "push" });
    expect(pushAdvice(fresh, ranged, 1)).toEqual({ kind: "push" });
    for (const n of [2, 3, 5]) {
      expect(pushAdvice(fresh, mixed, n)).toEqual({ kind: "push" });
      expect(pushAdvice(fresh, null, n)).toEqual({ kind: "push" });
      expect(pushAdvice(fresh, [], n)).toEqual({ kind: "push" });
      expect(pushAdvice(fresh, ranged, n)).toEqual({ kind: "bank", reasons: [{ kind: "stakes", encounter: n, worn: false, rangedParties: 2 }] });
      expect(pushAdvice(scratched, mixed, n)).toEqual({ kind: "bank", reasons: [{ kind: "stakes", encounter: n, worn: true, rangedParties: 0 }] });
      expect(pushAdvice(scratched, null, n)).toEqual({ kind: "bank", reasons: [{ kind: "stakes", encounter: n, worn: true, rangedParties: 0 }] });
      expect(pushAdvice(scratched, ranged, n)).toEqual({ kind: "bank", reasons: [{ kind: "stakes", encounter: n, worn: true, rangedParties: 2 }] });
    }
    // A badly-hurt reason keeps its place; the stakes reason comes last.
    const p: StakesLike = { units: [{ ref: "a", alive: true, hp: 4, maxHp: 10 }], traps: { remaining: [], spent: [] }, fences: { intact: [], destroyed: [] } };
    expect(pushAdvice(p, null, 2)).toEqual({ kind: "bank", reasons: [{ kind: "hurt", ref: "a", hp: 4, maxHp: 10 }, { kind: "stakes", encounter: 2, worn: true, rangedParties: 0 }] });
  });
});
