/**
 * Final play-test review, client side: the pure pieces behind S1 (the guide's reserve), N4
 * (region starters), N5 (the candidate summary), N8 (a guest caravan's name) and N11 (quiet
 * stretches in a replay).
 */
import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { generatedCaravanName, regionStarters } from "../login/LoginScreen.tsx";
import { QUIET_GAP_SECONDS, quietStretch } from "../replay/ReplayPlayer.tsx";
import { guidePrefill } from "../town/OutfitScreen.tsx";
import { scoutSummary } from "./CandidatesScreen.tsx";
import { fixtureScoutFor } from "./scoutFixture.ts";

const unit = (id: string, mergeLevel = 1) => ({ id, typeId: "desert.dust_rider", mergeLevel }) as never;

describe("S1: the guide's pre-fill leaves GUIDE_RESERVE units in town", () => {
  it("packs roster − GUIDE_RESERVE, highest level first, within the slot cap, at least one", () => {
    const seven = Array.from({ length: 7 }, (_, i) => unit(`u${i}`, i === 3 ? 2 : 1));
    const ids = guidePrefill(seven);
    expect(ids).toHaveLength(7 - TUNABLES.GUIDE_RESERVE);
    expect(ids[0]).toBe("u3");
    expect(guidePrefill(Array.from({ length: 20 }, (_, i) => unit(`u${i}`)))).toHaveLength(TUNABLES.DEPLOYMENT_SLOT_CAP);
    expect(guidePrefill([unit("only")])).toEqual(["only"]);
    expect(guidePrefill([])).toEqual([]);
  });
});

describe("N4 / N8: the start card", () => {
  it("names each region's starting units and their affinities, from content", () => {
    expect(regionStarters("desert")).toMatch(/^Starts with: .*Dust Rider \(Beast\).*Well Digger \(Grit\)/);
    expect(regionStarters("nowhere")).toBe("");
  });
  it("a guest caravan gets a two-part generated name", () => {
    expect(generatedCaravanName(() => 0)).toBe("Dusty Freighters");
    expect(generatedCaravanName(() => 0.999)).toMatch(/^\S.* \S/);
  });
});

describe("N5: the candidate summary", () => {
  it("counts raiders by stance, sums HP, names the siege and the sides, from the scout alone", () => {
    const scout = fixtureScoutFor(1);
    const s = scoutSummary(scout);
    expect(s.hp).toBe(scout.units.reduce((n, u) => n + u.hp, 0));
    expect(s.stances.length).toBeGreaterThan(0);
    expect(s.approach.length).toBeGreaterThan(0);
  });

  it("sets each siege counter against the caravan's own packed fence and traps when the server sends them (caravanLoadout)", () => {
    const base = fixtureScoutFor(1);
    const siege = [{ ...(base.siege[0] ?? ({} as never)), displayName: "Battering Wagon", counters: { kind: "fence", category: "wood" } }] as unknown as typeof base.siege;
    const scout = { ...base, siege };
    const loadout = {
      fences: [{ tierId: "fence.brush_pile", displayName: "Brush Pile", category: "wood", standing: 12, packed: 20 }],
      traps: [{ typeId: "trap.spike_pit", displayName: "Spike Pit", category: "pit", ready: 2, packed: 2 }],
    };
    expect(scoutSummary(scout, loadout).siege).toContain("counters 12 of your packed fence segments");
    expect(scoutSummary(scout, { ...loadout, fences: [] }).siege).toContain("none of your packed fence");
    expect(scoutSummary(scout).siege).not.toContain("your packed");
  });
});

describe("N11: quiet stretches", () => {
  const rate = 20;
  it("is quiet only when the next key moment is more than QUIET_GAP_SECONDS away and the fight is not ending", () => {
    const last = 100 * rate;
    expect(quietStretch([5 * rate], 0, last, rate)).toBe(false);
    expect(quietStretch([(QUIET_GAP_SECONDS + 2) * rate], 0, last, rate)).toBe(true);
    expect(quietStretch([], last - 2 * rate, last, rate)).toBe(false);
  });
});
