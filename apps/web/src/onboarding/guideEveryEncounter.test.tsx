/**
 * Final play-test review round 3 S1 (client part): the scout reading and the pick rule at every
 * guided encounter, the ranged count on every party card, and the advice that never pushes a hurt
 * circle at a menu of shooters.
 */
import { TUNABLES } from "@caravan/content";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CandidateView } from "../api/types.ts";
import { CandidateCard } from "../screens/trail/CandidatesScreen.tsx";
import { fixtureCandidate } from "../screens/trail/scoutFixture.ts";
import { CARAVAN_ID } from "../test/fixtures.ts";
import { fakeApi } from "../test/townFixtures.ts";
import { previewAfter1, statusDecide } from "../test/tripFixtures.ts";
import { ResultGuide, ScoutGuide } from "./TrailGuide.tsx";

const M = TUNABLES.ATTACK_RANGE_MELEE_DEFAULT;
function party(n: number, name: string, hps: number[], ranges: number[]): CandidateView {
  const base = fixtureCandidate(n);
  const unit = base.scout.units[0]!;
  return {
    ...base,
    owner: { ...base.owner, displayName: name },
    scout: { ...base.scout, units: hps.map((h, i) => ({ ...unit, ref: `${name}-${i}`, hp: h, attackRange: ranges[i]! as typeof unit.attackRange })), siege: [] },
  };
}
const rattler = party(1, "Rattler Den Gang", [380, 380, 640, 640], [M * 3.5, M * 3.5, M * 4, M * 4]);
const cistern = party(2, "The Cistern Gang", [1100, 620, 1100], [M, M, M]);
const claim = party(3, "Claim Jumpers' League", [640, 380, 640, 380], [M * 4, M * 3.5, M * 4, M * 3.5]);

describe("round 3 S1: the guide at every guided encounter", () => {
  it("encounter 2 gets the same scout reading: it passes over the ranged-only party and names the smallest that fights up close", () => {
    render(<ScoutGuide candidates={[rattler, cistern, claim]} encounterIndex={2} />);
    const card = screen.getByTestId("guide-scout");
    expect(card).toHaveTextContent("Encounter 2: scout before you choose");
    expect(screen.getByTestId("guide-scout-pick")).toHaveAttribute("data-index", "1");
    expect(screen.getByTestId("guide-scout-pick")).toHaveTextContent("The Cistern Gang is the smallest of the parties not made up only of shooters");
    expect(screen.getByTestId("guide-scout-ranged")).toHaveTextContent("Rattler Den Gang, Claim Jumpers' League");
    // N13: the how-to-read body is one tap away, below the pick.
    expect(within(card).getByTestId("guide-scout-how").tagName).toBe("DETAILS");
    expect(within(card).getByTestId("guide-scout-how")).not.toHaveAttribute("open");
  });

  it("every party card says how many raiders shoot from range, by shape and word", () => {
    const { rerender } = render(<CandidateCard candidate={rattler} busy={false} onChoose={vi.fn()} index={0} />);
    expect(screen.getByTestId("scout-ranged-0")).toHaveTextContent("◎ all 4: can hit posts from outside the fence");
    expect(screen.getByTestId("scout-ranged-0")).toHaveAttribute("data-ranged", "4");
    rerender(<CandidateCard candidate={cistern} busy={false} onChoose={vi.fn()} index={0} />);
    expect(screen.getByTestId("scout-ranged-0")).toHaveTextContent("○ none: every raider fights up close");
    rerender(<CandidateCard candidate={party(4, "Mixed", [900, 450], [M, M * 4])} busy={false} onChoose={vi.fn()} index={0} />);
    expect(screen.getByTestId("scout-ranged-0")).toHaveTextContent("◎ 1 of 2: can hit posts");
  });

  it("the deciding card at encounter 2 advises banking when the circle is hurt and every party just offered is ranged-heavy", async () => {
    const p = previewAfter1();
    const hurt = { ...p, units: p.units.map((u, i) => (i === 0 ? { ...u, hp: Math.max(1, u.maxHp - 50), alive: true } : { ...u, hp: u.maxHp, alive: true })) };
    const candidates = vi.fn(async () => ({ menu: { candidates: [rattler, claim] } as never }));
    const api = fakeApi({ tripPreview: vi.fn(async () => hurt), candidates });
    const enc = { ...statusDecide().trip!.encounters[0]!, index: 2 };
    render(<ResultGuide encounter={enc} deciding api={api} caravanId={CARAVAN_ID} />);
    const advice = await screen.findByTestId("guide-advice");
    await vi.waitFor(() => expect(advice).toHaveAttribute("data-advice", "bank"));
    expect(advice).toHaveTextContent("shoot from range");
    expect(candidates).toHaveBeenCalledWith(CARAVAN_ID, 2);
  });

  it("with a party that fights up close on the menu, the same scratched circle keeps the ordinary advice", async () => {
    const p = previewAfter1();
    const scratched = { ...p, units: p.units.map((u, i) => (i === 0 ? { ...u, hp: Math.max(1, u.maxHp - 50), alive: true } : { ...u, hp: u.maxHp, alive: true })) };
    const api = fakeApi({ tripPreview: vi.fn(async () => scratched), candidates: vi.fn(async () => ({ menu: { candidates: [rattler, cistern] } as never })) });
    render(<ResultGuide encounter={statusDecide().trip!.encounters[0]!} deciding api={api} caravanId={CARAVAN_ID} />);
    const advice = await screen.findByTestId("guide-advice");
    await new Promise((r) => setTimeout(r, 20));
    expect(advice).toHaveAttribute("data-advice", "push");
  });
});
