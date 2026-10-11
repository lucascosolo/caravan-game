import { getUnitType } from "@caravan/content";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoutPanel } from "./ScoutPanel.tsx";
import { FIXTURE_PARTIES, fixturePartyFor } from "./scoutFixture.ts";
import type { ScoutedEncounter } from "./scoutTypes.ts";

function enc(i: number, source: ScoutedEncounter["source"] = "fixture"): ScoutedEncounter {
  return { encounterIndex: i, party: fixturePartyFor(i), source, ownerLabel: null };
}

describe("ScoutPanel — nothing about the party is hidden", () => {
  it("shows every unit with type, merge level, HP, stance, entry edge and exact start cell, both ratings, speed, range, cooldown and ability", () => {
    const e = enc(2);
    render(<ScoutPanel encounter={e} />);
    for (const u of e.party.units) {
      const card = within(screen.getByTestId(`scout-unit-${u.ref}`));
      const t = getUnitType(u.typeId)!;
      expect(card.getByText(t.displayName)).toBeInTheDocument();
      expect(card.getByText(new RegExp(`Merge level ${u.mergeLevel}`))).toBeInTheDocument();
      expect(card.getByText(new RegExp(`${u.hp} / ${u.maxHp} HP`))).toBeInTheDocument();
      expect(card.getByText(new RegExp(`\\(${u.entry.cell.x}, ${u.entry.cell.y}\\)`))).toBeInTheDocument();
      expect(card.getByText(new RegExp(`from the ${u.entry.edge}`))).toBeInTheDocument();
      expect(card.getByText(/Targets the nearest enemy|Prioritizes traps|Beelines for the core/)).toBeInTheDocument();
      // Two ratings, both present, offense emphasized.
      const pair = card.getByRole("group", { name: new RegExp(`Offense ${u.offense}, Defense ${t.defense}`) });
      expect(pair.querySelector(".statpair__stat--big .statpair__lbl")?.textContent).toBe("Offense");
      expect(card.getByText(t.ability.displayName)).toBeInTheDocument();
      expect(card.getByText(new RegExp(t.ability.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
      expect(card.getByText("Cooldown")).toBeInTheDocument();
      expect(card.getByText("Range (cells)")).toBeInTheDocument();
      expect(card.getByText("Attack every")).toBeInTheDocument();
      expect(card.getByText("Speed (cells/s)")).toBeInTheDocument();
    }
  });

  it("shows a healer's finite charges", () => {
    const e = enc(2);
    const healer = e.party.units.find((u) => u.ability.archetype === "heal_radius")!;
    render(<ScoutPanel encounter={e} />);
    const card = within(screen.getByTestId(`scout-unit-${healer.ref}`));
    expect(card.getByText(/charges per fight — finite, not regenerating/)).toBeInTheDocument();
  });

  it("shows every siege piece with what it counters, and the per-edge approach summary", () => {
    const e = enc(3);
    render(<ScoutPanel encounter={e} />);
    for (const s of e.party.siege) {
      const card = within(screen.getByTestId(`scout-siege-${s.ref}`));
      expect(card.getByText(new RegExp(`Counters ${s.counters.category} ${s.counters.kind}s`))).toBeInTheDocument();
    }
    const approach = screen.getByTestId("scout-approach");
    for (const edge of ["north", "east", "south", "west"]) {
      const n = e.party.units.filter((u) => u.entry.edge === edge).length;
      expect(approach.querySelector(`[data-edge="${edge}"]`)?.getAttribute("data-count")).toBe(String(n));
    }
  });

  it("says plainly when the party is a fixture, and not when matchmaking served it", () => {
    const { unmount } = render(<ScoutPanel encounter={enc(1)} />);
    expect(screen.getByTestId("scout-fixture-hint")).toBeInTheDocument();
    unmount();
    render(<ScoutPanel encounter={enc(1, "matchmaking")} />);
    expect(screen.queryByTestId("scout-fixture-hint")).toBeNull();
  });

  it("fixtures are deterministic per encounter index and every start cell is inside its edge's entry band", () => {
    expect(fixturePartyFor(1)).toBe(fixturePartyFor(4));
    for (const p of FIXTURE_PARTIES) {
      for (const u of p.units) {
        const c = u.entry.cell;
        const ok =
          (u.entry.edge === "north" && c.y < 2) || (u.entry.edge === "south" && c.y >= 30) || (u.entry.edge === "west" && c.x < 2) || (u.entry.edge === "east" && c.x >= 30);
        expect(ok).toBe(true);
      }
    }
  });
});
