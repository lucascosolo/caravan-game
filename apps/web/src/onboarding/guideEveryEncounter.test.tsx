/**
 * Final play-test review round 3 S1 (client part): the scout reading and the pick rule at every
 * guided encounter, the ranged count on every party card, and the advice that never pushes a hurt
 * circle at a menu of shooters.
 */
import { TUNABLES } from "@caravan/content";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CandidateView } from "../api/types.ts";
import type { StakesPreview } from "../api/tripTypes.ts";
import { CandidateCard } from "../screens/trail/CandidatesScreen.tsx";
import { fixtureCandidate } from "../screens/trail/scoutFixture.ts";
import { CARAVAN_ID } from "../test/fixtures.ts";
import { fakeApi } from "../test/townFixtures.ts";
import { previewAfter1, statusDecide } from "../test/tripFixtures.ts";
import { STRINGS } from "../strings.ts";
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

describe("round 4 D1: from encounter 2 the advice reads the stakes, and the card's title follows it", () => {
  const G = STRINGS.guide;
  const whole = (): StakesPreview => {
    const p = previewAfter1();
    return {
      ...p,
      units: p.units.map((u) => ({ ...u, hp: u.maxHp, alive: true })),
      traps: { ...p.traps, remaining: [...p.traps.remaining, ...p.traps.spent], spent: [] },
      fences: { ...p.fences, intact: [...p.fences.intact, ...p.fences.destroyed.map((f) => ({ ...f, hp: f.maxHp }))], destroyed: [] },
      unbankedCoin: { ...p.unbankedCoin, total: 900 },
    };
  };
  const scratched = () => {
    const p = whole();
    return { ...p, units: p.units.map((u, i) => (i === 0 ? { ...u, hp: Math.max(1, u.maxHp - 50) } : u)) };
  };
  async function decide(index: number, preview: StakesPreview, menu: CandidateView[]) {
    const api = fakeApi({ tripPreview: vi.fn(async () => preview), candidates: vi.fn(async () => ({ menu: { candidates: menu } as never })) });
    const enc = { ...statusDecide().trip!.encounters[0]!, index };
    const view = render(<ResultGuide encounter={enc} deciding api={api} caravanId={CARAVAN_ID} />);
    const advice = await screen.findByTestId("guide-advice");
    await new Promise((r) => setTimeout(r, 20));
    const kind = advice.getAttribute("data-advice") as "bank" | "push";
    // The CI pin: the card's title is the one for the advice it shows.
    expect(within(screen.getByTestId("guide-result")).getByRole("heading")).toHaveTextContent(G.decideTitleFor(kind));
    const out = { kind, text: advice.textContent ?? "", reasons: advice.getAttribute("data-reasons") };
    view.unmount();
    return out;
  }

  it("an unhurt circle against a menu that fights up close is advised to push, without the encounter-1 escalation line", async () => {
    for (const n of [2, 3]) {
      const a = await decide(n, whole(), [rattler, cistern]);
      expect(a.kind).toBe("push");
      expect(a.text).not.toContain("One push shows how encounters escalate");
      expect(a.text).toContain(`encounter ${n} unhurt`);
    }
  });

  it("a scratched circle, or a menu of shooters, is advised to bank, with the unbanked Coin and the units at stake", async () => {
    const units = whole().units.length;
    const hurt = await decide(2, scratched(), [rattler, cistern]);
    expect(hurt).toMatchObject({ kind: "bank", reasons: "stakes" });
    expect(hurt.text).toContain("the 900 unbanked Coin");
    expect(hurt.text).toContain(`the ${units} units still standing`);
    expect(hurt.text).toContain("Your circle has taken losses.");
    const shooters = await decide(3, whole(), [rattler, claim]);
    expect(shooters).toMatchObject({ kind: "bank", reasons: "stakes" });
    expect(shooters.text).toContain("Every one of the 2 parties you were just offered");
    expect(shooters.text).not.toContain("taken losses");
  });

  it("encounter 1 keeps its advice and its copy, under the matching title", async () => {
    const a = await decide(1, scratched(), [rattler, cistern]);
    expect(a.kind).toBe("push");
    expect(a.text).toContain("One push shows how encounters escalate");
  });
});
