import { describe, expect, it } from "vitest";
import { expectShape } from "../api/shape.ts";
import { partyShape } from "../api/shapes.ts";
import { fixtureCandidate } from "../screens/trail/scoutFixture.ts";
import partyJson from "../test/contract/party.json";
import onboardingJson from "../test/contract/onboarding.json";
import { onboardingShape } from "./shapes.ts";
import { prefillParty, stepForFacts } from "./ShellGuide.tsx";
import { ONBOARDING_STEPS } from "./steps.ts";
import { isRangedOnly, pushAdvice, showsAt, smallestCandidate, stepForMoment } from "./TrailGuide.tsx";
import { TUNABLES } from "@caravan/content";
import type { CandidateView } from "../api/types.ts";
import { STRINGS } from "../strings.ts";
import { previewAfter1 } from "../test/tripFixtures.ts";

describe("the guide's step model (chunk 24)", () => {
  it("maps each Trail moment of the first trip to its step", () => {
    expect(stepForMoment({ kind: "arranging", encounterIndex: 1, searched: false, chosen: false })).toBe("scout");
    expect(stepForMoment({ kind: "arranging", encounterIndex: 1, searched: true, chosen: true })).toBe("arrange");
    expect(stepForMoment({ kind: "resolving", encounterIndex: 1 })).toBe("arrange");
    expect(stepForMoment({ kind: "decide", encounterIndex: 1 })).toBe("result");
    expect(stepForMoment({ kind: "arranging", encounterIndex: 2, searched: false, chosen: false })).toBe("free");
    expect(stepForMoment({ kind: "decide", encounterIndex: 2 })).toBe("bank");
    expect(stepForMoment({ kind: "ended" })).toBe("party");
    expect(stepForMoment({ kind: "other" })).toBeNull();
  });

  it("shows a Trail card only while the account has not gone past that moment", () => {
    const enc1 = { kind: "arranging", encounterIndex: 1, searched: true, chosen: true } as const;
    expect(showsAt("scout", enc1)).toBe(true);
    expect(showsAt("arrange", enc1)).toBe(true);
    expect(showsAt("result", enc1)).toBe(false);
    expect(showsAt(null, enc1)).toBe(false);
    expect(showsAt("bank", { kind: "decide", encounterIndex: 2 })).toBe(true);
    // A trip pushed past the second encounter keeps no guide at 3.
    expect(showsAt("party", { kind: "decide", encounterIndex: 3 })).toBe(false);
    expect(showsAt("bank", { kind: "ended" })).toBe(false);
  });

  it("moves the town steps on from the server's state only; the roster step waits for a refugee claim, not a unit (every caravan starts with some)", () => {
    expect(stepForFacts("roster", { refugeeClaimed: false, tripOpen: false, lastEnd: null })).toBeNull();
    expect(stepForFacts("roster", { refugeeClaimed: true, tripOpen: false, lastEnd: null })).toBe("outfit");
    expect(stepForFacts("outfit", { refugeeClaimed: false, tripOpen: true, lastEnd: null })).toBe("scout");
    expect(stepForFacts("roster", { refugeeClaimed: false, tripOpen: true, lastEnd: null })).toBe("scout");
    expect(stepForFacts("arrange", { refugeeClaimed: false, tripOpen: false, lastEnd: "overrun" })).toBe("party");
    expect(stepForFacts("party", { refugeeClaimed: false, tripOpen: false, lastEnd: "banked" })).toBeNull();
  });

  it("recommends the smallest served party by the scout alone: least total HP, then fewest siege, then fewest raiders, then menu order (QA N2)", () => {
    const [a, b, c] = [fixtureCandidate(1), fixtureCandidate(2), fixtureCandidate(3)];
    const hp = (x: CandidateView) => x.scout.units.reduce((n, u) => n + u.hp, 0);
    const pick = smallestCandidate([b, c, a])!;
    const all = [b, c, a];
    const least = Math.min(...all.map(hp));
    expect(pick.hp).toBe(least);
    expect(hp(all[pick.index]!)).toBe(least);
    expect(smallestCandidate([])).toBeNull();
    expect(smallestCandidate([a, a])!.index).toBe(0);
  });

  it("QA N2: Cougar Ridge (5 raiders, 3 siege, 6,049 HP) does not read smaller than Powder Thief (6 raiders, 2 siege, 3,673 HP); one strong raider does not win", () => {
    const base = fixtureCandidate(1);
    const unit = base.scout.units[0]!;
    const siege = base.scout.siege[0];
    const party = (hps: number[], nSiege: number): CandidateView => ({
      ...base,
      scout: { ...base.scout, units: hps.map((h, i) => ({ ...unit, ref: `u${i}`, hp: h })), siege: siege ? Array.from({ length: nSiege }, (_, i) => ({ ...siege, ref: `s${i}` })) : [] },
    });
    const cougar = party([1210, 1210, 1210, 1210, 1209], 3);
    const powder = party([613, 612, 612, 612, 612, 612], 2);
    expect(smallestCandidate([cougar, powder])!.index).toBe(1);
    const oneBig = party([3000], 0);
    const threeSmall = party([500, 500, 500], 0);
    expect(smallestCandidate([oneBig, threeSmall])!.index).toBe(1);
    // Equal HP: fewer siege pieces first, then fewer raiders.
    expect(smallestCandidate([party([500, 500], 2), party([500, 500], 1)])!.index).toBe(1);
    expect(smallestCandidate([party([500, 500], 1), party([1000], 1)])!.index).toBe(1);
  });

  it("final play-test review r2 S2: an all-ranged party is passed over whenever another candidate exists, however small it is", () => {
    const base = fixtureCandidate(1);
    const unit = base.scout.units[0]!;
    const melee = TUNABLES.ATTACK_RANGE_MELEE_DEFAULT;
    const party = (hps: number[], ranges: number[]): CandidateView => ({
      ...base,
      scout: { ...base.scout, units: hps.map((h, i) => ({ ...unit, ref: `u${i}`, hp: h, attackRange: ranges[i]! as typeof unit.attackRange })), siege: [] },
    });
    const gunslingers = party([380, 380], [melee * 4, melee * 3]);
    const mixed = party([900, 450], [melee, melee * 4]);
    // A long arm is not a gun: a Grizzly's 1.2-cell swipe with a Trapper is a mixed party.
    expect(isRangedOnly(party([1300, 450], [Math.round(melee * 1.2), melee * 4]))).toBe(false);
    const brawlers = party([1100, 1100], [melee, melee]);
    expect(isRangedOnly(gunslingers)).toBe(true);
    expect(isRangedOnly(mixed)).toBe(false);
    expect(smallestCandidate([gunslingers, brawlers, mixed])!.index).toBe(2);
    expect(smallestCandidate([gunslingers, brawlers])!.index).toBe(1);
    // Nothing else on the menu: the smallest all-ranged party is still the reading.
    expect(smallestCandidate([party([900, 900], [melee * 4, melee * 4]), gunslingers])!.index).toBe(1);
  });

  it("QA D2: the bank-or-push advice reads the stakes — a 74/1100 survivor means bank, and no card ever says the trip pushes", () => {
    const hurt = { ...previewAfter1(), units: previewAfter1().units.map((u, i) => (i === 0 ? { ...u, hp: 74, maxHp: 1100, alive: true } : u)) };
    const a = pushAdvice(hurt);
    expect(a.kind).toBe("bank");
    const fine = { ...previewAfter1(), units: previewAfter1().units.map((u) => ({ ...u, hp: u.maxHp, alive: true })) };
    expect(pushAdvice(fine).kind).toBe("push");
    for (const s of Object.values(STRINGS.guide)) if (typeof s === "string") expect(s).not.toMatch(/pushes once/);
  });

  it("pre-fills the standing party from the roster with the builder's defaults, never past the cap, never a locked type", () => {
    const view = expectShape(partyShape, partyJson.body).party;
    // A party that already fields every unlocked roster unit: nothing to add.
    const full = { ...view, config: { ...view.config, units: prefillParty({ ...view, config: { ...view.config, units: [] } })!.units } };
    expect(prefillParty(full)).toBeNull();
    // The recorded party (which the starting roster, chunk 24 QA D1, outnumbers) keeps its own and adds the rest.
    const topped = prefillParty(view)!;
    expect(topped.units.slice(0, view.config.units.length)).toEqual(view.config.units);
    // r4 D1: the saved units, then unlocked roster units not in it, up to SUGGESTED_PARTY_MAX (never cutting the saved ones).
    const saved = view.config.units.map((u) => u.ref);
    const adds = view.roster.filter((r) => r.unlocked && !saved.includes(r.instanceId)).map((r) => r.instanceId);
    expect(new Set(topped.units.map((u) => u.ref))).toEqual(new Set([...saved, ...adds].slice(0, Math.max(saved.length, Math.min(view.caps.units, TUNABLES.SUGGESTED_PARTY_MAX)))));
    const empty = { ...view, config: { ...view.config, units: [] } };
    const filled = prefillParty(empty)!;
    expect(filled.units.map((u) => u.ref)).toEqual(view.roster.filter((r) => r.unlocked).map((r) => r.instanceId).slice(0, Math.min(view.caps.units, TUNABLES.SUGGESTED_PARTY_MAX)));
    expect(filled.units.every((u) => u.stance === "nearest" && u.edge === "north")).toBe(true);
    const locked = { ...empty, roster: empty.roster.map((r) => ({ ...r, unlocked: false })) };
    expect(prefillParty(locked)).toBeNull();
    const capped = { ...empty, caps: { ...empty.caps, units: 1 } };
    expect(prefillParty(capped)!.units).toHaveLength(1);
  });

  it("the recorded first-screen body names the same steps in the same order", () => {
    const body = expectShape(onboardingShape, onboardingJson.body);
    expect(body.onboarding.step).toBe("welcome");
    expect(body.onboarding.steps).toEqual(ONBOARDING_STEPS);
    expect(() => expectShape(onboardingShape, { onboarding: { ...onboardingJson.body.onboarding, steps: [...ONBOARDING_STEPS].reverse() } })).toThrow(/steps/);
  });
});
