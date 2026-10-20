import { abilityDisplay, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { survivorsManifest } from "../../test/circleFixtures.ts";
import { fixtureScoutFor } from "./scoutFixture.ts";
import { abilityActsWhenPosted, attackerCard, defenderCard } from "./stats.ts";

describe("stat cards: ratings never merge-scale; HP does (chunk 03 QA B1, chunk 09 QA X1)", () => {
  it("a posted level-2 unit shows the type's defense and the manifest's merge-scaled HP", () => {
    const digger = survivorsManifest().units.find((u) => u.ref === "u-digger")!;
    expect(digger.mergeLevel).toBe(2);
    const type = getUnitType(digger.typeId)!;
    const card = defenderCard(digger)!;
    expect(card.emphasis).toBe("defense");
    expect(card.defense).toBe(type.defense);
    expect(card.offense).toBe(type.offense);
    expect(card.defense).not.toBe(scaleInt(type.defense, mergeStatMult(2)));
    expect(card.maxHp).toBe(scaleInt(type.hp, mergeStatMult(2)));
    expect(card.maxHp).toBeGreaterThan(type.hp);
    expect(card.hp).toBe(digger.hp);
  });

  it("a scouted attacker shows the view's ratings untouched, and max HP at its merge level", () => {
    const scout = fixtureScoutFor(1);
    const merged = scout.units.find((u) => u.mergeLevel === 2)!;
    const type = getUnitType(merged.typeId)!;
    const card = attackerCard(merged);
    expect(card.emphasis).toBe("offense");
    expect(card.offense).toBe(type.offense);
    expect(card.defense).toBe(type.defense);
    expect(card.maxHp).toBe(merged.hp);
    expect(card.maxHp).toBe(scaleInt(type.hp, mergeStatMult(2)));
  });

  it("the posted unit's card carries content's display-ready ability numbers (chunk 12 QA S5), the same the scout view sends", () => {
    for (const u of survivorsManifest().units) {
      const t = getUnitType(u.typeId)!;
      const d = abilityDisplay(t.ability, t.attackRange);
      // r3 N11: a raid-only ability (a structure breaker) says so on a posted unit, and lists no numbers it never uses.
      if (!abilityActsWhenPosted(t.ability)) {
        expect(defenderCard(u)!.ability.name).toBe(`${t.ability.displayName} (raiding only)`);
        expect(defenderCard(u)!.ability.lines).toEqual([]);
        continue;
      }
      const lines = defenderCard(u)!.ability.lines.map((l) => `${l.label}: ${l.value}`);
      expect(lines).toContain(`First use: after ${d.firstUseSeconds} s`);
      if (d.reachCells !== null) expect(lines).toContain(`Reach: ${d.reachCells} cells`);
      if (d.healPercent !== null) expect(lines.join("\n")).toContain("never above the HP the unit started the fight with");
      if (d.fenceHitCapPercent !== null) expect(lines.join("\n")).toContain(`${d.fenceHitCapPercent}% of a segment's max HP per hit`);
    }
  });
});
