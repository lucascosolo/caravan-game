/**
 * Chunk 22: the replay player against the server's recorded replay bodies (contract
 * fixtures) and a golden log. The canvas is mocked to expose what the scene was handed; the
 * real renderer is chunk 08's and is exercised by the e2e.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { ReplayView } from "../../api/replayTypes.ts";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { goldenView, replayCaravan, replayNoLog, replayOwner } from "../../test/replayFixtures.ts";
import { resetViewerState } from "../../auth/session.tsx";
import { fakeApi, partyView } from "../../test/townFixtures.ts";
import { PartyScreen } from "../party/PartyScreen.tsx";
import { statusDecide } from "../../test/tripFixtures.ts";
import { EncounterResult } from "../trail/EncounterResult.tsx";
import { ReplayPlayer } from "./ReplayPlayer.tsx";

vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => 0 }));
    const s = props.state;
    return (
      <div
        data-testid="iso-canvas"
        aria-label={props.label}
        data-units={s.replayUnits?.length ?? 0}
        data-attackers={(s.replayUnits ?? []).filter((u) => u.side === "attacker").length}
        data-fences={s.fences.length}
        data-spent={s.traps.filter((t) => t.spent).length}
        data-lattice={s.drag || s.placing ? "on" : "off"}
      />
    );
  });
  return { ...actual, IsoCanvas };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function apiFor(view: ReplayView | (() => Promise<ReplayView>)): { api: Api; replay: ReturnType<typeof vi.fn> } {
  const replay = vi.fn(typeof view === "function" ? view : async () => view);
  return { api: fakeApi({ replay }), replay };
}

async function renderPlayer(view: ReplayView, extra: Partial<Parameters<typeof ReplayPlayer>[0]> = {}) {
  const { api, replay } = apiFor(view);
  render(<ReplayPlayer jobId={view.jobId} api={api} {...extra} />);
  const player = await screen.findByTestId("replay-player");
  return { player, replay };
}

const scrubTo = (tick: number): void => {
  fireEvent.change(screen.getByTestId("replay-scrub"), { target: { value: String(tick) } });
};

describe("the replay player, the caravan's side (the server's recorded fight)", () => {
  it("leads with the results summary: the recorded outcome, depth with the DEPTH_METRIC sentence, loot, the tally", async () => {
    const view = replayCaravan();
    const { player, replay } = await renderPlayer(view);
    expect(replay).toHaveBeenCalledWith(view.jobId);
    expect(player).toHaveAttribute("data-viewer", "caravan");
    expect(screen.getByTestId("replay-intro")).toHaveTextContent("Your wagon circle against the raiding party you scouted. Nothing is fought again");
    const summary = screen.getByTestId("replay-summary");
    expect(within(summary).getByTestId("replay-outcome")).toHaveTextContent("Your caravan held.");
    const pct = Math.round((view.outcome!.depth * 100) / 1024);
    expect(within(summary).getByTestId("replay-depth")).toHaveTextContent(`Depth: the raiders got ${pct}% of the way to your core.`);
    expect(within(summary).getByTestId("replay-depth")).toHaveTextContent("Deepest: the raiders' Dust Rider.");
    expect(within(summary).getByTestId("replay-depth-explained")).toHaveTextContent(view.depthExplained);
    expect(within(summary).getByTestId("replay-loot")).toHaveTextContent(`Loot reported for the raiding party's owner: ${view.outcome!.loot} Coin.`);
    expect(within(summary).getByTestId("replay-tally")).toHaveTextContent("Raiders down: 2 of 2");
    expect(within(summary).getByTestId("replay-tally")).toHaveTextContent("Your posted units down: 1 of 2");
    expect(within(summary).getByTestId("replay-tally")).toHaveTextContent("Traps sprung: 1 of 1");
    // No end card before the end; the canvas has every unit at tick 0, and the lattice is off (nothing is being placed).
    expect(screen.queryByTestId("replay-end-card")).toBeNull();
    const canvas = screen.getByTestId("iso-canvas");
    expect(canvas).toHaveAttribute("data-units", "4");
    expect(canvas).toHaveAttribute("data-lattice", "off");
    expect(screen.getByTestId("replay-feed")).toHaveTextContent("Nothing yet.");
  });

  it("scrubbing to the end always shows the recorded outcome; the feed is the log's rows up to the moment shown", async () => {
    const view = replayCaravan();
    await renderPlayer(view);
    const ticks = (view.log as { ticks: number }).ticks;
    scrubTo(369);
    const feed = screen.getByTestId("replay-feed");
    expect(feed).toHaveTextContent("Your Spike Pit sprang on the raiders' Well Digger: 250 damage.");
    expect(feed).not.toHaveTextContent("fell.");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-spent", "1");
    scrubTo(ticks - 1);
    const end = screen.getByTestId("replay-end-card");
    expect(end).toHaveAttribute("data-outcome", view.outcome!.kind);
    expect(end).toHaveTextContent("End of the fight");
    expect(end).toHaveTextContent("Your caravan held.");
    expect(feed).toHaveTextContent("Your Well Digger 1 fell.");
    expect(feed).toHaveTextContent("The raiders' Dust Rider used Spur On: dashed");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-units", "1");
    expect(screen.getByTestId("replay-play")).toHaveTextContent("Watch again");
    expect(screen.getByTestId("replay-time")).toHaveTextContent(/^0:39 \/ 0:39$/);
  });

  it("key moments hide the hits; everything shows them again", async () => {
    await renderPlayer(replayCaravan());
    scrubTo(200);
    const feed = screen.getByTestId("replay-feed");
    expect(within(feed).getAllByText(/ hit /).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId("replay-feed-key"));
    expect(within(feed).queryAllByText(/ hit /)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Everything" }));
    expect(within(feed).getAllByText(/ hit /).length).toBeGreaterThan(0);
  });

  it("keyframe seeks: next and previous land on keyframe ticks; skip to the end shows the end card", async () => {
    const view = replayCaravan();
    await renderPlayer(view);
    const scrub = screen.getByTestId("replay-scrub") as HTMLInputElement;
    const interval = (view.log as { keyframeInterval: number }).keyframeInterval;
    await userEvent.click(screen.getByTestId("replay-next-keyframe"));
    expect(Number(scrub.value)).toBe(interval - 1);
    await userEvent.click(screen.getByTestId("replay-next-keyframe"));
    expect(Number(scrub.value)).toBe(2 * interval - 1);
    await userEvent.click(screen.getByTestId("replay-prev-keyframe"));
    expect(Number(scrub.value)).toBe(interval - 1);
    expect(scrub).toHaveAttribute("aria-valuetext", "0:04 of 0:39");
    await userEvent.click(screen.getByTestId("replay-to-end"));
    expect(screen.getByTestId("replay-end-card")).toBeInTheDocument();
  });

  it("plays: fight time runs at the log's tick rate times the chosen speed (1×, 2×, 4×), and pauses", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    let now = 0;
    /** Run `steps` animation frames, `stepMs` of wall time apart. */
    const flush = (stepMs: number, steps: number): void => {
      for (let i = 0; i < steps; i++) {
        const cb = frames.shift();
        if (!cb) return;
        act(() => cb(now));
        now += stepMs;
      }
    };
    await renderPlayer(replayCaravan());
    const scrub = screen.getByTestId("replay-scrub") as HTMLInputElement;
    expect(screen.getByTestId("replay-speed-1")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("replay-speed-4"));
    expect(screen.getByTestId("replay-speed-4")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("replay-speed-1")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByTestId("replay-play"));
    expect(screen.getByTestId("replay-play")).toHaveTextContent("Pause");
    // 1 s of wall time at 4× and 20 ticks/s ≈ 80 ticks (the first frame only starts the clock).
    flush(100, 11);
    expect(Number(scrub.value)).toBeGreaterThanOrEqual(78);
    expect(Number(scrub.value)).toBeLessThanOrEqual(80);
    // While playing, the feed is not a live region (a screen reader would drown at 4×).
    expect(screen.getByTestId("replay-feed")).toHaveAttribute("aria-live", "off");
    await userEvent.click(screen.getByTestId("replay-play"));
    expect(screen.getByTestId("replay-play")).toHaveTextContent("Play");
    expect(screen.getByTestId("replay-feed")).toHaveAttribute("aria-live", "polite");
  });
});

describe("the replay player, the party owner's side", () => {
  it("tells the fight from the party's side: where it came in, its loot, what was credited", async () => {
    const view = replayOwner();
    const { player } = await renderPlayer(view, { settled: { coin: 0, reputation: 3, ladder: 1 } });
    expect(player).toHaveAttribute("data-viewer", "party_owner");
    expect(screen.getByTestId("replay-intro")).toHaveTextContent("Your standing party was served into someone's trip while you were away. It came in from the north and east.");
    expect(screen.getByTestId("replay-intro")).toHaveTextContent("Your party lost nothing; it is a template.");
    expect(screen.getByTestId("replay-outcome")).toHaveTextContent("Your party was stopped: the caravan held.");
    expect(screen.getByTestId("replay-depth")).toHaveTextContent("Depth: your party got");
    expect(screen.getByTestId("replay-depth")).toHaveTextContent("Deepest: your Dust Rider.");
    expect(screen.getByTestId("replay-loot")).toHaveTextContent(`Your party's loot from this fight: ${view.outcome!.loot} Coin, as reported.`);
    expect(screen.getByTestId("replay-settled")).toHaveTextContent("Credited: 0 Coin · +3 Reputation · +1 ladder.");
    expect(screen.getByTestId("replay-tally")).toHaveTextContent("Your raiders down: 2 of 2");
    scrubTo((view.log as { ticks: number }).ticks - 1);
    expect(screen.getByTestId("replay-feed")).toHaveTextContent("The caravan's Spike Pit sprang on your Well Digger");
    expect(screen.getByTestId("replay-end-card")).toHaveTextContent("Your party was stopped: the caravan held.");
  });
});

describe("a golden log with traps, fence breaks and abilities plays through the player", () => {
  it("combat-full-load-16v8v28: an overrun, fence breaks and siege-nullified traps in the feed", async () => {
    const view = goldenView("combat-full-load-16v8v28");
    await renderPlayer(view);
    expect(screen.getByTestId("replay-outcome")).toHaveTextContent("Your caravan was overrun.");
    expect(screen.getByTestId("replay-depth")).toHaveTextContent("The raiders reached your core.");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-units", "24");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-fences", "28");
    await userEvent.click(screen.getByTestId("replay-to-end"));
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-fences", "24");
    const feed = screen.getByTestId("replay-feed");
    expect(feed).toHaveTextContent("reached the core.");
    expect(feed).toHaveTextContent(/Your Brush Pile #\d+ broke\./);
    expect(feed).toHaveTextContent("the party's siege made it harmless.");
    expect(screen.getByTestId("replay-end-card")).toHaveTextContent("Your caravan was overrun.");
    expect(screen.getByTestId("replay-tally")).toHaveTextContent("The core was reached.");
  });
});

describe("states that cannot play", () => {
  it("a fight resolved without a log says so, with the reason, and still shows the recorded outcome", async () => {
    const view = replayNoLog();
    const { api } = apiFor(view);
    render(<ReplayPlayer jobId={view.jobId} api={api} />);
    const box = await screen.findByTestId("replay-not-renderable");
    expect(box).toHaveAttribute("data-no-log", "true");
    expect(box).toHaveTextContent("No replay was recorded for this fight");
    expect(screen.getByTestId("replay-reason")).toHaveTextContent("Reason: no replay log was recorded for this fight");
    expect(screen.getByTestId("replay-outcome")).toHaveTextContent("Your caravan held.");
    expect(screen.queryByTestId("iso-canvas")).toBeNull();
  });

  it("a log the server marked unreadable is never drawn", async () => {
    const view = { ...replayCaravan(), renderable: false, reason: "log format v99 (resolver v6) is not readable by this server's replay reader (reads 1)" };
    const { api } = apiFor(view);
    render(<ReplayPlayer jobId={view.jobId} api={api} />);
    const box = await screen.findByTestId("replay-not-renderable");
    expect(box).toHaveTextContent("This fight cannot be played back");
    expect(box).toHaveTextContent("log format v99");
    expect(screen.queryByTestId("iso-canvas")).toBeNull();
  });

  it("a truncated log fails loudly with the reader's message", async () => {
    const base = replayCaravan();
    const log = base.log as { events: unknown[] };
    const view = { ...base, log: { ...log, events: log.events.slice(0, -2) } };
    const { api } = apiFor(view);
    render(<ReplayPlayer jobId={view.jobId} api={api} />);
    expect(await screen.findByTestId("replay-reason")).toHaveTextContent("replay refused");
    expect(screen.queryByTestId("iso-canvas")).toBeNull();
  });

  it.each([
    [409, "not_resolved", "This fight has not been fought out yet."],
    [410, "replay_expired", "This replay is past its keeping window and has been cleared."],
    [404, "no_replay", "There is no fight to show here."],
  ])("%i %s has its own copy", async (status, code, copy) => {
    const { api } = apiFor(async () => {
      throw new ApiError(status, code, "server message");
    });
    render(<ReplayPlayer jobId="encounter:x:1" api={api} />);
    const box = await screen.findByTestId("replay-unavailable");
    expect(box).toHaveTextContent(copy);
    expect(box).toHaveAttribute("data-code", code);
  });

  it("a network failure offers Retry, which asks again", async () => {
    let n = 0;
    const view = replayCaravan();
    const { api, replay } = apiFor(async () => {
      if (n++ === 0) throw new ApiError(0, "network", "fetch failed");
      return view;
    });
    render(<ReplayPlayer jobId={view.jobId} api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("replay-player")).toBeInTheDocument();
    expect(replay).toHaveBeenCalledTimes(2);
  });
});

describe("Watch the fight (the trip's encounter results)", () => {
  it("opens the player over the results for that encounter's job, and Close returns to them", async () => {
    const enc = statusDecide().trip!.encounters[0]!;
    const view = { ...replayCaravan(), jobId: enc.result!.jobId };
    const { api, replay } = apiFor(view);
    render(<EncounterResult encounter={enc} api={api} />);
    const watch = screen.getByTestId("watch-fight");
    expect(watch).toBeEnabled();
    await userEvent.click(watch);
    const dialog = await screen.findByRole("dialog", { name: "Encounter 1: the fight" });
    expect(replay).toHaveBeenCalledWith(enc.result!.jobId);
    expect(await within(dialog).findByTestId("replay-player")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByTestId("replay-close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("encounter-result-1")).toBeInTheDocument();
  });
});

describe("Watch the fight (the party owner's results feed)", () => {
  it("each feed entry with a fight opens it from the party's side, with what was credited", async () => {
    const view = replayOwner();
    const replay = vi.fn(async () => view);
    const entry = {
      seq: 7,
      occurredAt: "2026-10-11T12:00:00.000Z",
      jobId: view.jobId,
      encounterIndex: 1,
      defender: { username: "someone", caravanName: "Dusty Wheels", regionId: "desert" },
      outcomeKind: "caravan_held",
      coinEarned: 0,
      reputationDelta: 2,
      ladderPointsGained: 1,
    };
    const noFight = { ...entry, seq: 6, jobId: null };
    const api = fakeApi({
      party: vi.fn(async () => ({ party: partyView() })),
      partyFeed: vi.fn(async () => ({ entries: [entry, noFight], nextBefore: 0, hasMore: false })),
      replay,
    });
    resetViewerState();
    render(<PartyScreen api={api} />);
    const watch = await screen.findByTestId("feed-watch-7");
    expect(watch).toHaveTextContent("Watch the fight");
    expect(screen.queryByTestId("feed-watch-6")).toBeNull();
    await userEvent.click(watch);
    const dialog = await screen.findByRole("dialog", { name: "Encounter 1: the fight" });
    expect(replay).toHaveBeenCalledWith(view.jobId);
    expect(await within(dialog).findByTestId("replay-player")).toHaveAttribute("data-viewer", "party_owner");
    expect(within(dialog).getByTestId("replay-settled")).toHaveTextContent("Credited: 0 Coin · +2 Reputation · +1 ladder.");
  });
});
