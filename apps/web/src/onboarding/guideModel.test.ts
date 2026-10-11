import { describe, expect, it } from "vitest";
import { expectShape } from "../api/shape.ts";
import { partyShape } from "../api/shapes.ts";
import { fixtureCandidate } from "../screens/trail/scoutFixture.ts";
import partyJson from "../test/contract/party.json";
import onboardingJson from "../test/contract/onboarding.json";
import { onboardingShape } from "./shapes.ts";
import { prefillParty, stepForFacts } from "./ShellGuide.tsx";
import { ONBOARDING_STEPS } from "./steps.ts";
import { showsAt, smallestCandidate, stepForMoment } from "./TrailGuide.tsx";

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

  it("moves the town steps on from the server's state only", () => {
    expect(stepForFacts("roster", { units: 0, tripOpen: false, lastEnd: null })).toBeNull();
    expect(stepForFacts("roster", { units: 1, tripOpen: false, lastEnd: null })).toBe("outfit");
    expect(stepForFacts("outfit", { units: 1, tripOpen: true, lastEnd: null })).toBe("scout");
    expect(stepForFacts("roster", { units: 1, tripOpen: true, lastEnd: null })).toBe("scout");
    expect(stepForFacts("arrange", { units: 1, tripOpen: false, lastEnd: "overrun" })).toBe("party");
    expect(stepForFacts("party", { units: 0, tripOpen: false, lastEnd: "banked" })).toBeNull();
  });

  it("recommends the smallest served party by the scout alone: fewest raiders, then least HP, then menu order", () => {
    const [a, b, c] = [fixtureCandidate(1), fixtureCandidate(2), fixtureCandidate(3)];
    const pick = smallestCandidate([b, c, a]);
    expect(pick).toEqual({ index: 2, raiders: 3, hp: a.scout.units.reduce((n, u) => n + u.hp, 0) });
    expect(smallestCandidate([])).toBeNull();
    expect(smallestCandidate([a, a])!.index).toBe(0);
  });

  it("pre-fills the standing party from the roster with the builder's defaults, never past the cap, never a locked type", () => {
    const view = expectShape(partyShape, partyJson.body).party;
    // The recorded party already fields its roster: nothing to add.
    expect(prefillParty(view)).toBeNull();
    const empty = { ...view, config: { ...view.config, units: [] } };
    const filled = prefillParty(empty)!;
    expect(filled.units.map((u) => u.ref)).toEqual(view.roster.filter((r) => r.unlocked).map((r) => r.instanceId).slice(0, view.caps.units));
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
