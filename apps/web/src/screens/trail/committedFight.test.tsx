/** Final play-test review r4 N5: after a reload mid-resolve, the committed fight's replay still opens once. */
import { render, screen } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { fakeApi, meWith } from "../../test/townFixtures.ts";
import { previewAfter1, statusDecide, statusResolving } from "../../test/tripFixtures.ts";
import { rememberCommitted, takeCommitted } from "./committedFight.ts";
import { TrailScreen } from "./TrailScreen.tsx";

vi.mock("../replay/ReplayPlayer.tsx", () => ({
  ReplayPlayer: ({ jobId }: { jobId: string }) => <div data-testid="replay-player-stub">{jobId}</div>,
}));
vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(_props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => 0 }));
    return <div data-testid="iso-canvas" />;
  });
  return { ...actual, IsoCanvas };
});

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  window.location.hash = "";
});

const decide = statusDecide();
const api = () =>
  fakeApi({
    me: async () => meWith([]),
    tripStatus: vi.fn().mockResolvedValueOnce(statusResolving()).mockResolvedValue(decide),
    tripPreview: vi.fn(async () => ({ ...previewAfter1(), tripId: decide.trip!.id })),
  });

describe("r4 N5: the committed fight's replay survives a reload", () => {
  it("the remembered commit is taken once, for its own manifest and encounter only", () => {
    rememberCommitted("m1", 2);
    expect(takeCommitted("m1", 1)).toBe(false);
    expect(takeCommitted("m2", 2)).toBe(false);
    expect(takeCommitted("m1", 2)).toBe(true);
    expect(takeCommitted("m1", 2)).toBe(false);
  });

  it("a page that loads mid-resolve opens the replay once the result is in, then forgets it", async () => {
    rememberCommitted(decide.trip!.manifestId, decide.trip!.decisionFor!);
    const first = render(<TrailScreen api={api()} pollBackoffMs={[5, 5, 5]} />);
    expect(await screen.findByTestId("replay-player-stub", {}, { timeout: 3000 })).toHaveTextContent(decide.trip!.encounters[0]!.result!.jobId);
    first.unmount();
    // A later visit to the same decision does not open it by itself.
    render(<TrailScreen api={api()} pollBackoffMs={[5, 5, 5]} />);
    await screen.findByTestId("encounter-result-1", {}, { timeout: 3000 });
    expect(screen.queryByTestId("replay-player-stub")).toBeNull();
  });
});
