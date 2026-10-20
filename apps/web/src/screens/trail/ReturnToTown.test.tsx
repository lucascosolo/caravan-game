/**
 * Final guardrail review r4 S1: when no raiding party can be served (409 `pool_empty`), the Trail
 * offers one-tap "Return to town", which voids the trip on the server; r4 N4: a menu drawn before
 * a game update (409 `menu_stale`) sends the player back to a free search.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { TripStatusView } from "../../api/tripTypes.ts";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { expectShape } from "../../api/shape.ts";
import { menuShape } from "../../api/shapes.ts";
import { STRINGS } from "../../strings.ts";
import searchJson from "../../test/contract/search.json";
import { CARAVAN_ID, fakeApi, meWith } from "../../test/townFixtures.ts";
import { statusArranging, statusVoided } from "../../test/tripFixtures.ts";
import { TrailScreen } from "./TrailScreen.tsx";

vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(_props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => 0 }));
    return <div data-testid="iso-canvas" />;
  });
  return { ...actual, IsoCanvas };
});

afterEach(() => {
  window.location.hash = "";
});

const me = async () => meWith([]);
const searchNotYet = vi.fn(async () => {
  throw new ApiError(404, "no_search", "no candidates have been searched");
});

function apiWith(statuses: TripStatusView[], over: Partial<Api> = {}): Api {
  let i = 0;
  const tripStatus = vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]!);
  return fakeApi({ me, tripStatus, candidates: searchNotYet, ...over });
}

describe("r4 S1: Return to town", () => {
  it("a search that cannot fill a menu shows the player-facing reason and a Return to town button; one tap voids the trip", async () => {
    const user = userEvent.setup();
    const arranging = statusArranging(1);
    const voided = statusVoided();
    const searchCandidates = vi.fn(async () => {
      throw new ApiError(409, "pool_empty", "No raiding party can be served to your caravan for this encounter right now.", undefined, [], { returnToTown: true });
    });
    const returnToTown = vi.fn(async () => ({ returned: true, status: voided }));
    // Reads: the initial load, the status the return reads for the trip id, then the load after it.
    const manifest = vi.fn(async () => {
      throw new ApiError(404, "no_open_manifest", "nothing packed");
    });
    const economy = vi.fn(async () => {
      throw new ApiError(0, "network", "offline");
    });
    const api = apiWith([arranging, arranging, voided], { searchCandidates, returnToTown, manifest, economy });
    render(<TrailScreen api={api} />);
    await user.click(await screen.findByTestId("search"));
    const box = await screen.findByTestId("pool-empty");
    expect(box).toHaveTextContent(STRINGS.trail.returnToTownBody);
    expect(screen.queryByText(/seed/)).toBeNull();
    await user.click(screen.getByTestId("return-to-town"));
    expect(returnToTown).toHaveBeenCalledWith(CARAVAN_ID, arranging.trip!.id, 1);
    expect(await screen.findByTestId("trip-summary")).toBeInTheDocument();
  });

  it("other search errors are shown as before, with no Return to town", async () => {
    const user = userEvent.setup();
    const searchCandidates = vi.fn(async () => {
      throw new ApiError(409, "wrong_encounter", "not this one");
    });
    render(<TrailScreen api={apiWith([statusArranging(1)], { searchCandidates })} />);
    await user.click(await screen.findByTestId("search"));
    expect(await screen.findByText("not this one")).toBeInTheDocument();
    expect(screen.queryByTestId("return-to-town")).toBeNull();
  });
});

describe("r4 N4: a menu drawn before a game update", () => {
  it("choosing from it (409 menu_stale) says why and goes back to a free search", async () => {
    const user = userEvent.setup();
    const { menu } = expectShape(menuShape, searchJson.body);
    const searchCandidates = vi.fn(async () => ({ menu }));
    const chooseCandidate = vi.fn(async () => {
      throw new ApiError(409, "menu_stale", "the game was updated");
    });
    render(<TrailScreen api={apiWith([statusArranging(1)], { searchCandidates, chooseCandidate })} />);
    await user.click(await screen.findByTestId("search"));
    const choose = await screen.findAllByRole("button", { name: /choose|face|pick/i });
    await user.click(choose[0]!);
    expect(chooseCandidate).toHaveBeenCalled();
    expect(await screen.findByTestId("trail-unsearched")).toBeInTheDocument();
    expect(screen.getByTestId("trail-notice")).toHaveTextContent(STRINGS.trail.menuStale);
    expect(screen.getByTestId("search")).toBeEnabled();
  });
});
