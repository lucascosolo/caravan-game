/**
 * Final play-test review round 3 decision: through the authored-only phase (until the caravan has
 * banked AUTHORED_ONLY_UNTIL_BANKS trips) the guide's help stays after the onboarding — the scout
 * reading, the bank-or-push advice and an OPTIONAL "Arrange for me" — gated on the server's own
 * `authoredOnlyTrip` flag, so it goes away by itself afterwards. The menu line says why.
 */
import { EMPTY_FORMATION, guidedFormation, validateFormation, type Formation } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectShape } from "../api/shape.ts";
import { candidatesReadShape } from "../api/shapes.ts";
import type { CandidateMenuView } from "../api/types.ts";
import { CandidatesScreen } from "../screens/trail/CandidatesScreen.tsx";
import { fixtureScoutFor } from "../screens/trail/scoutFixture.ts";
import { packedManifest } from "../test/circleFixtures.ts";
import candidatesJson from "../test/contract/candidates.json";
import { CARAVAN_ID } from "../test/fixtures.ts";
import { fakeApi } from "../test/townFixtures.ts";
import { previewAfter1, statusDecide } from "../test/tripFixtures.ts";
import { AssistAdvice, AssistArrange } from "./AssistGuide.tsx";

const recorded = expectShape(candidatesReadShape, candidatesJson.body).menu!;
const menuWith = (authoredOnlyTrip: boolean): CandidateMenuView => ({ ...recorded, authoredOnlyTrip });
const read = (authoredOnlyTrip: boolean) => vi.fn(async () => ({ menu: menuWith(authoredOnlyTrip) }));

describe("the authored-only phase's help (round 3 decision)", () => {
  it("the recorded menu carries the flag; an authored-only menu says why, never the 30 % share", () => {
    expect(recorded.authoredOnlyTrip).toBe(false);
    render(<CandidatesScreen encounterIndex={1} menu={menuWith(true)} busy={false} error={null} onSearchAgain={vi.fn()} onChoose={vi.fn()} />);
    const line = screen.getByTestId("authored-share");
    expect(line).toHaveAttribute("data-authored-only", "true");
    expect(line).toHaveTextContent(`until it has banked ${TUNABLES.AUTHORED_ONLY_UNTIL_BANKS} trips`);
    expect(line).not.toHaveTextContent("30%");
  });

  it("'Arrange for me' appears only on an authored-only encounter, and applies the shared guidedFormation", async () => {
    const m = packedManifest();
    const scout = fixtureScoutFor(1);
    const apply = vi.fn((_f: Formation) => undefined);
    const { unmount } = render(<AssistArrange api={fakeApi({ candidates: read(false) })} caravanId={CARAVAN_ID} encounterIndex={1} manifest={m} formation={EMPTY_FORMATION} scout={scout} locked={false} apply={apply} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("assist-arrange")).toBeNull();
    unmount();
    render(<AssistArrange api={fakeApi({ candidates: read(true) })} caravanId={CARAVAN_ID} encounterIndex={1} manifest={m} formation={EMPTY_FORMATION} scout={scout} locked={false} apply={apply} />);
    await userEvent.setup().click(await screen.findByTestId("assist-arrange-do"));
    expect(apply).toHaveBeenCalledTimes(1);
    const f = apply.mock.calls[0]![0];
    expect(f).toEqual(guidedFormation(m, scout));
    expect(validateFormation(m, f, () => true).ok).toBe(true);
  });

  it("the bank-or-push advice appears only on an authored-only encounter", async () => {
    const enc = statusDecide().trip!.encounters[0]!;
    const { unmount } = render(<AssistAdvice api={fakeApi({ candidates: read(false), tripPreview: vi.fn(async () => previewAfter1()) })} caravanId={CARAVAN_ID} encounter={enc} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("assist-advice")).toBeNull();
    unmount();
    render(<AssistAdvice api={fakeApi({ candidates: read(true), tripPreview: vi.fn(async () => previewAfter1()) })} caravanId={CARAVAN_ID} encounter={enc} />);
    expect(await screen.findByTestId("guide-advice")).toHaveAttribute("data-advice");
  });
});
