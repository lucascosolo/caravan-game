import { getFenceTier, getTrapType, getUnitType, mergeStatMult } from "@caravan/content";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixedToText } from "../webs/catalogue.ts";
import { ScoutPanel } from "./ScoutPanel.tsx";
import { FIXTURE_PARTIES, fixtureScoutFor } from "./scoutFixture.ts";

describe("ScoutPanel — nothing about the party is hidden", () => {
  it("shows every unit with type, merge level, HP, stance, entry edge and exact start cell, both ratings (offense emphasized), speed, range, cooldown and ability", () => {
    const scout = fixtureScoutFor(2);
    render(<ScoutPanel scout={scout} />);
    for (const u of scout.units) {
      const card = within(screen.getByTestId(`scout-unit-${u.ref}`));
      const t = getUnitType(u.typeId)!;
      expect(card.getByText(u.displayName)).toBeInTheDocument();
      expect(card.getByText(new RegExp(`Merge level ${u.mergeLevel}`))).toBeInTheDocument();
      expect(card.getByText(new RegExp(`${u.hp} / ${u.hp} HP`))).toBeInTheDocument();
      expect(card.getByText(new RegExp(`\\(${u.cell.x}, ${u.cell.y}\\)`))).toBeInTheDocument();
      expect(card.getByText(new RegExp(`from the ${u.edge}`))).toBeInTheDocument();
      expect(card.getByText(/Targets the nearest enemy|Prioritizes traps|Beelines for the core/)).toBeInTheDocument();
      const pair = card.getByRole("group", { name: new RegExp(`Offense ${u.offense}, Defense ${u.defense}`) });
      expect(pair.querySelector(".statpair__stat--big .statpair__lbl")?.textContent).toBe("Offense");
      expect(card.getByText(t.ability.displayName)).toBeInTheDocument();
      expect(card.getByText(new RegExp(t.ability.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
      expect(card.getByText("Cooldown")).toBeInTheDocument();
      expect(card.getByText("Range (cells)")).toBeInTheDocument();
      expect(card.getByText("Attack every")).toBeInTheDocument();
      expect(card.getByText("Speed")).toBeInTheDocument();
      expect(card.getByText(/cells\/s$/)).toBeInTheDocument();
      // QA S1: the merge-scaled damage per hit, from the server's view (merge scales output, never the rating).
      expect(card.getByText("Damage per hit")).toBeInTheDocument();
      expect(card.getByText(`×${fixedToText(mergeStatMult(u.mergeLevel))} (merge level ${u.mergeLevel})`)).toBeInTheDocument();
      expect(u.damagePerHitMult).toBe(mergeStatMult(u.mergeLevel));
    }
    expect(screen.getByText(`${scout.unitSlots.used} of ${scout.unitSlots.cap} unit slots`, { exact: false })).toBeInTheDocument();
  });

  it("a merged attacker's per-hit multiplier is above an unmerged one's (S1), and a tapped attacker's card is marked (S14)", () => {
    const scout = fixtureScoutFor(2);
    const merged = scout.units.find((u) => u.mergeLevel > 1)!;
    const plain = scout.units.find((u) => u.mergeLevel === 1)!;
    expect(merged.damagePerHitMult).toBeGreaterThan(plain.damagePerHitMult);
    render(<ScoutPanel scout={scout} selectedRef={merged.ref} />);
    expect(screen.getByTestId(`scout-unit-${merged.ref}`)).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId(`scout-unit-${plain.ref}`)).toHaveAttribute("data-selected", "false");
  });

  it("shows a healer's finite charges", () => {
    const scout = fixtureScoutFor(2);
    const healer = scout.units.find((u) => u.ability.archetype === "heal_radius")!;
    render(<ScoutPanel scout={scout} />);
    expect(within(screen.getByTestId(`scout-unit-${healer.ref}`)).getByText(/charges per fight — finite, not regenerating/)).toBeInTheDocument();
  });

  it("shows the ability's display-ready numbers from the scout view (chunk 12 QA S5): first use, reach, heal ceiling, buff, fence-hit cap", () => {
    for (const seed of [1, 2, 3]) {
      const scout = fixtureScoutFor(seed);
      const { unmount } = render(<ScoutPanel scout={scout} />);
      for (const u of scout.units) {
        const d = u.abilityDisplay!;
        const card = screen.getByTestId(`scout-unit-${u.ref}`);
        expect(card).toHaveTextContent(`First useafter ${d.firstUseSeconds} s`);
        expect(card).toHaveTextContent(`${d.cooldownSeconds} s`);
        if (d.reachCells !== null) expect(card).toHaveTextContent(`Reach${d.reachCells} cells`);
        if (d.healPercent !== null) expect(card).toHaveTextContent(`${d.healPercent}% of max HP, never above the HP the unit started the fight with`);
        if (d.buffPercent !== null) expect(card).toHaveTextContent(`+${d.buffPercent}% for ${d.buffSeconds} s`);
        if (d.fenceHitCapPercent !== null) expect(card).toHaveTextContent(`Fence-hit cap${d.fenceHitCapPercent}% of a segment's max HP per hit`);
        if (d.dashCells !== null) expect(card).toHaveTextContent(`${d.dashCells} cells`);
      }
      unmount();
    }
  });

  it("shows every siege piece with what it counters, how (accelerates/bypasses, multiplier) and the exact types affected, plus the per-edge approach", () => {
    const scout = fixtureScoutFor(3);
    render(<ScoutPanel scout={scout} />);
    for (const s of scout.siege) {
      const card = within(screen.getByTestId(`scout-siege-${s.typeId}`));
      expect(card.getByText(s.displayName)).toBeInTheDocument();
      expect(card.getByText(new RegExp(`Counters ${s.counters.category} ${s.counters.kind}s`))).toBeInTheDocument();
      expect(card.getByText(s.effect === "accelerates" ? /Breaks these faster/ : /Walks past these/)).toBeInTheDocument();
      for (const id of s.targetTypeIds) {
        const name = getFenceTier(id)?.displayName ?? getTrapType(id)?.displayName ?? id;
        expect(card.getByText(new RegExp(name))).toBeInTheDocument();
      }
    }
    const approach = screen.getByTestId("scout-approach");
    for (const edge of ["north", "east", "south", "west"]) {
      const n = scout.units.filter((u) => u.edge === edge).length;
      const li = approach.querySelector(`[data-edge="${edge}"]`)!;
      expect(li.getAttribute("data-count")).toBe(String(n));
      expect(li.getAttribute("data-used")).toBe(scout.edges.includes(edge as never) ? "yes" : "no");
    }
  });

  it("says plainly when the party is a test fixture, and not for a matchmaking candidate", () => {
    const { unmount } = render(<ScoutPanel scout={fixtureScoutFor(1)} source="fixture" />);
    expect(screen.getByTestId("scout-fixture-hint")).toBeInTheDocument();
    unmount();
    render(<ScoutPanel scout={fixtureScoutFor(1)} />);
    expect(screen.queryByTestId("scout-fixture-hint")).toBeNull();
  });

  it("fixtures are deterministic per encounter index and every start cell is inside its edge's entry band", () => {
    expect(fixtureScoutFor(1)).toEqual(fixtureScoutFor(4));
    for (const p of FIXTURE_PARTIES) {
      for (const u of p.units) {
        const c = u.cell;
        const ok = (u.edge === "north" && c.y < 2) || (u.edge === "south" && c.y >= 30) || (u.edge === "west" && c.x < 2) || (u.edge === "east" && c.x >= 30);
        expect(ok).toBe(true);
      }
    }
  });
});
