/**
 * Chunk 22: the replay player against the server's recorded replay bodies (contract
 * fixtures) and a golden log. The canvas is mocked to expose what the scene was handed; the
 * real renderer is chunk 08's and is exercised by the e2e (which also proves the real canvas
 * keeps updating: pixels and the renderer's frame counter, QA S9).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { RecentFightsView, ReplayView } from "../../api/replayTypes.ts";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { STRINGS } from "../../strings.ts";
import { goldenView, replayCaravan, replayCompacted, replayNoLog, replayOwner } from "../../test/replayFixtures.ts";
import { resetViewerState } from "../../auth/session.tsx";
import { fakeApi, partyView } from "../../test/townFixtures.ts";
import { PartyScreen } from "../party/PartyScreen.tsx";
import { statusDecide } from "../../test/tripFixtures.ts";
import { EncounterResult } from "../trail/EncounterResult.tsx";
import { RecentFights } from "./RecentFights.tsx";
import { ReplayPlayer, resetReplaySpeed, setQuietFastForwardForTests } from "./ReplayPlayer.tsx";
import { END_HOLD_SECONDS } from "./replayModel.ts";

vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => 0 }));
    const s = props.state;
    const marks = s.marks ?? [];
    return (
      <div
        data-testid="iso-canvas"
        aria-label={props.label}
        data-units={s.replayUnits?.length ?? 0}
        data-attackers={(s.replayUnits ?? []).filter((u) => u.side === "attacker").length}
        data-fences={s.fences.length}
        data-spent={s.traps.filter((t) => t.spent).length}
        data-lattice={s.drag || s.placing ? "on" : "off"}
        data-marks={marks.map((m) => m.kind).join(",")}
        data-highlighted={(s.replayUnits ?? []).filter((u) => u.highlighted).map((u) => u.id).join(",")}
        data-stances={(s.replayUnits ?? []).map((u) => u.stance ?? "-").join(",")}
        data-siege={s.siege.map((x) => x.typeId).join(",")}
        data-frame={props.frame ? `${props.frame.x},${props.frame.y},${props.frame.w},${props.frame.h}` : ""}
        data-touch-scroll={props.touchScroll ? "true" : "false"}
      />
    );
  });
  return { ...actual, IsoCanvas };
});

/** A controllable animation-frame clock: `flush(ms, n)` runs n frames `ms` of wall time apart. */
function stubClock(): { flush: (stepMs: number, steps: number) => void } {
  const frames: { id: number; cb: FrameRequestCallback }[] = [];
  let next = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push({ id: next, cb });
    return next++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    const i = frames.findIndex((f) => f.id === id);
    if (i >= 0) frames.splice(i, 1);
  });
  let now = 0;
  return {
    flush: (stepMs, steps) => {
      for (let i = 0; i < steps; i++) {
        const f = frames.shift();
        if (!f) return;
        act(() => f.cb(now));
        now += stepMs;
      }
    },
  };
}

beforeEach(() => resetReplaySpeed());
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

/** Scrub to the end and let the end hold run out (1 s of wall time at the current speed). */
function toEndAndHold(clockStub: ReturnType<typeof stubClock>, ticks: number): void {
  scrubTo(ticks - 1);
  clockStub.flush(100, Math.ceil((END_HOLD_SECONDS * 1000) / 100) + 3);
}

describe("the replay player, the caravan's side (the server's recorded fight)", () => {
  it("stage first (pinned), then the controls, then the summary collapsed under the recorded outcome (QA S3)", async () => {
    const view = replayCaravan();
    const { player, replay } = await renderPlayer(view);
    expect(replay).toHaveBeenCalledWith(view.jobId);
    expect(player).toHaveAttribute("data-viewer", "caravan");
    const order = [...player.children].map((c) => c.getAttribute("data-testid") ?? c.tagName.toLowerCase());
    expect(order.slice(0, 3)).toEqual(["replay-stage", "replay-controls", "replay-intro"]);
    expect(screen.getByTestId("replay-intro")).toHaveTextContent("Your wagon circle against the raiding party you scouted. Nothing is fought again");
    const toggle = screen.getByTestId("replay-summary-toggle");
    expect(toggle).not.toHaveAttribute("open");
    expect(within(toggle).getByText(/^How it ended: Your caravan held\.$/)).toBeInTheDocument();
    const summary = screen.getByTestId("replay-summary");
    expect(within(summary).getByTestId("replay-outcome")).toHaveTextContent("Your caravan held.");
    const pct = Math.floor((view.outcome!.depth * 100) / 1024);
    expect(within(summary).getByTestId("replay-depth")).toHaveTextContent(STRINGS.replay.depth(pct, "caravan"));
    expect(within(summary).getByTestId("replay-depth")).toHaveTextContent("Deepest: the raiders' Dust Rider.");
    expect(within(summary).getByTestId("replay-depth-explained")).toHaveTextContent(STRINGS.replay.depthExplained);
    expect(within(summary).getByTestId("replay-loot")).toHaveTextContent(`Loot reported for the raiding party's owner: ${view.outcome!.loot} Coin.`);
    const tally = within(summary).getByTestId("replay-tally");
    expect(tally).toHaveTextContent("Raiders down: 2 of 2");
    expect(tally).toHaveTextContent("Your posted units down: 0 of 2"); // chunk 37 balance pass: the contract fixture's fight re-recorded under the tuned content (defense ×1.5, traps ×1.5, speed ×0.7) — no posted unit falls now
    expect(tally).toHaveTextContent("Traps sprung: 1 of 1");
    // The canvas: every unit at tick 0, the lattice off, stances and siege from the server's labels, framed on the action, vertical swipes scroll.
    expect(screen.queryByTestId("replay-end-card")).toBeNull();
    const canvas = screen.getByTestId("iso-canvas");
    expect(canvas).toHaveAttribute("data-units", "4");
    expect(canvas).toHaveAttribute("data-lattice", "off");
    expect(canvas).toHaveAttribute("data-stances", "nearest,traps,hold,guard");
    expect(canvas).toHaveAttribute("data-siege", "siege.battering_wagon");
    expect(canvas).toHaveAttribute("data-touch-scroll", "true");
    expect(canvas.getAttribute("data-frame")).not.toBe("");
    expect(screen.getByTestId("replay-siege")).toHaveTextContent("Siege with the raiders: Battering Wagon (hits timber fences harder).");
    expect(screen.getByTestId("replay-feed")).toHaveTextContent("Nothing yet.");
    expect(screen.getByTestId("replay-strip")).toHaveTextContent("Nothing yet.");
  });

  it("S8: the caravan's summary itemizes what the ledger settled for this encounter", async () => {
    await renderPlayer(replayCaravan());
    const settled = screen.getByTestId("replay-settled");
    expect(settled).toHaveAttribute("data-applied", "true");
    expect(settled).toHaveTextContent("600 Coin earned here, not banked yet: it is at risk until the trip banks.");
    // REPUTATION_CARAVAN_HELD 15 → 10 (chunk 37) → 8 (balance pass 5); the gap is level since the final play-test review D6, so the full +8.
    expect(settled).toHaveTextContent("Reputation (caravan): +8.");
    expect(settled).toHaveTextContent("Ladder (caravan): +25 points.");
    expect(settled).toHaveTextContent("Ladder (trap): +25 points.");
    expect(settled).toHaveTextContent("Units that fell here are de-merged one level when the trip ends; that is not written yet.");
  });

  it("S7: how each fighter fared, from the rows", async () => {
    await renderPlayer(replayCaravan());
    const fates = screen.getByTestId("replay-fates");
    expect(fates).toHaveTextContent("Your Well Digger 1: still standing at the end.");
    expect(fates).toHaveTextContent("The raiders' Dust Rider: fell to your Well Digger 1 at 0:19.");
    expect(fates).toHaveTextContent("The raiders' Well Digger: fell to your Well Digger 2 at 0:30.");
  });

  it("S1: at the end the last frame is held, the deciding kill's mark plays out, then the end card shows — and can be dismissed", async () => {
    const clockStub = stubClock();
    const view = replayCaravan();
    await renderPlayer(view);
    const ticks = (view.log as { ticks: number }).ticks;
    scrubTo(519);
    const feed = screen.getByTestId("replay-feed");
    expect(feed).toHaveTextContent("Your Spike Pit sprang on the raiders' Well Digger: 375 damage.");
    expect(feed).not.toHaveTextContent("Well Digger fell");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-spent", "1");
    scrubTo(ticks - 1);
    // On the final tick: the stage is NOT covered, and the last raider's death is marked on it.
    expect(screen.queryByTestId("replay-end-card")).toBeNull();
    expect(screen.getByTestId("iso-canvas").getAttribute("data-marks")).toContain("death");
    expect(screen.getByTestId("replay-strip")).toHaveTextContent("The raiders' Well Digger fell to your Well Digger 2.");
    clockStub.flush(100, 5);
    expect(screen.queryByTestId("replay-end-card")).toBeNull();
    expect(screen.getByTestId("iso-canvas").getAttribute("data-marks")).toContain("death");
    clockStub.flush(100, 10);
    const end = screen.getByTestId("replay-end-card");
    expect(end).toHaveAttribute("data-outcome", view.outcome!.kind);
    expect(end).toHaveTextContent("End of the fight");
    expect(end).toHaveTextContent("Your caravan held.");
    expect(feed).toHaveTextContent("The raiders' Dust Rider fell to your Well Digger 1.");
    expect(feed).toHaveTextContent("The raiders' Well Digger fell to your Well Digger 2.");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-units", "2");
    expect(screen.getByTestId("replay-play")).toHaveTextContent("Watch again");
    expect(screen.getByTestId("replay-time")).toHaveTextContent(/^0:30 \/ 0:30$/);
    await userEvent.click(within(end).getByTestId("replay-end-dismiss"));
    expect(screen.queryByTestId("replay-end-card")).toBeNull();
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-units", "2");
  });

  it("the feed defaults to key moments (QA S3); everything shows the hits, fence hits included", async () => {
    await renderPlayer(replayCaravan());
    scrubTo(200);
    const feed = screen.getByTestId("replay-feed");
    expect(screen.getByTestId("replay-feed-key")).toHaveAttribute("aria-pressed", "true");
    expect(within(feed).queryAllByText(/ hit /)).toHaveLength(0);
    await userEvent.click(screen.getByTestId("replay-feed-all"));
    expect(within(feed).getAllByText(/ hit /).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId("replay-feed-key"));
    expect(within(feed).queryAllByText(/ hit /)).toHaveLength(0);
  });

  it("N5: tapping a feed line highlights its units on the field", async () => {
    await renderPlayer(replayCaravan());
    scrubTo(560);
    const line = screen.getByRole("button", { name: /Your Spike Pit sprang on the raiders' Well Digger: 375 damage\. Show on the field\./ });
    await userEvent.click(line);
    expect(line).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("iso-canvas").getAttribute("data-highlighted")).toBe("1");
    await userEvent.click(line);
    expect(screen.getByTestId("iso-canvas").getAttribute("data-highlighted")).toBe("");
  });

  it("N1: back / forward step one keyframe interval, labelled in seconds from the log; skip to the end shows the end card after the hold", async () => {
    const clockStub = stubClock();
    const view = replayCaravan();
    await renderPlayer(view);
    const scrub = screen.getByTestId("replay-scrub") as HTMLInputElement;
    const interval = (view.log as { keyframeInterval: number }).keyframeInterval;
    expect(screen.getByTestId("replay-next-keyframe")).toHaveTextContent("Forward 5 s");
    expect(screen.getByTestId("replay-prev-keyframe")).toHaveTextContent("Back 5 s");
    await userEvent.click(screen.getByTestId("replay-next-keyframe"));
    expect(Number(scrub.value)).toBe(interval - 1);
    await userEvent.click(screen.getByTestId("replay-next-keyframe"));
    expect(Number(scrub.value)).toBe(2 * interval - 1);
    await userEvent.click(screen.getByTestId("replay-prev-keyframe"));
    expect(Number(scrub.value)).toBe(interval - 1);
    expect(scrub).toHaveAttribute("aria-valuetext", "0:04 of 0:30");
    await userEvent.click(screen.getByTestId("replay-to-end"));
    expect(screen.queryByTestId("replay-end-card")).toBeNull();
    clockStub.flush(100, 15);
    expect(screen.getByTestId("replay-end-card")).toBeInTheDocument();
  });

  it("N11: a quiet stretch (no key moment for a while) plays fast and says so; plain speeds resume at the next key moment", async () => {
    const clockStub = stubClock();
    await renderPlayer(replayCaravan());
    const scrub = screen.getByTestId("replay-scrub") as HTMLInputElement;
    await userEvent.click(screen.getByTestId("replay-play"));
    clockStub.flush(100, 11);
    // The recorded fight opens with no key moment for over 8 s: 1 s of wall time covers more than 2× would (40 ticks).
    expect(screen.getByTestId("replay-quiet")).toHaveTextContent("fast-forwarding to the next key moment");
    expect(Number(scrub.value)).toBeGreaterThan(40);
  });

  it("D4: 2× by default; fight time runs at the tick rate × speed; the choice is remembered for the session", async () => {
    setQuietFastForwardForTests(false);
    onTestFinished(() => setQuietFastForwardForTests(true));
    const clockStub = stubClock();
    await renderPlayer(replayCaravan());
    const scrub = screen.getByTestId("replay-scrub") as HTMLInputElement;
    expect(screen.getByTestId("replay-speed-2")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("replay-play"));
    expect(screen.getByTestId("replay-play")).toHaveTextContent("Pause");
    // 1 s of wall time at 2× and 20 ticks/s ≈ 40 ticks (the first frame only starts the clock).
    clockStub.flush(100, 11);
    expect(Number(scrub.value)).toBeGreaterThanOrEqual(38);
    expect(Number(scrub.value)).toBeLessThanOrEqual(40);
    await userEvent.click(screen.getByTestId("replay-speed-4"));
    expect(screen.getByTestId("replay-speed-4")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("replay-speed-2")).toHaveAttribute("aria-pressed", "false");
    const before = Number(scrub.value);
    clockStub.flush(100, 10);
    expect(Number(scrub.value) - before).toBeGreaterThanOrEqual(78);
    expect(Number(scrub.value) - before).toBeLessThanOrEqual(81);
    // While playing, the feed is not a live region (a screen reader would drown at 4×).
    expect(screen.getByTestId("replay-feed")).toHaveAttribute("aria-live", "off");
    await userEvent.click(screen.getByTestId("replay-play"));
    expect(screen.getByTestId("replay-play")).toHaveTextContent("Play");
    expect(screen.getByTestId("replay-feed")).toHaveAttribute("aria-live", "polite");
    // A second player in the same session opens at the speed chosen last.
    cleanup();
    const view = replayOwner();
    render(<ReplayPlayer jobId={view.jobId} api={fakeApi({ replay: vi.fn(async () => view) })} />);
    const again = await screen.findByTestId("replay-player");
    expect(within(again).getByTestId("replay-speed-4")).toHaveAttribute("aria-pressed", "true");
  });

  it("N2: holding the scrub pauses playback; letting go resumes it", async () => {
    const clockStub = stubClock();
    await renderPlayer(replayCaravan());
    const scrub = screen.getByTestId("replay-scrub") as HTMLInputElement;
    await userEvent.click(screen.getByTestId("replay-play"));
    clockStub.flush(100, 3);
    fireEvent.pointerDown(scrub);
    expect(screen.getByTestId("replay-play")).toHaveTextContent("Play");
    fireEvent.change(scrub, { target: { value: "300" } });
    clockStub.flush(100, 5);
    expect(Number(scrub.value)).toBe(300);
    fireEvent.pointerUp(scrub);
    expect(screen.getByTestId("replay-play")).toHaveTextContent("Pause");
    clockStub.flush(100, 5);
    expect(Number(scrub.value)).toBeGreaterThan(300);
  });
});

describe("the replay player, the party owner's side", () => {
  it("final play-test review r3 N5: with settled.coinEarned the owner's total is the credited Coin, and transferred Coin is its own line", async () => {
    stubClock();
    const base = replayOwner();
    const view = { ...base, settled: { ...base.settled, coinEarned: 300, coinTransferred: 120 } };
    await renderPlayer(view, { settled: { coin: 300, reputation: 3, ladder: 1 } });
    expect(screen.getByTestId("replay-loot")).toHaveTextContent("Your party earned 300 Coin from this fight.");
    expect(screen.getByTestId("replay-loot")).not.toHaveTextContent("as reported");
    expect(screen.getByTestId("replay-loot-transferred")).toHaveTextContent("120 of it was the caravan's unbanked Coin");
    cleanup();
    stubClock();
    await renderPlayer({ ...base, settled: { ...base.settled, coinEarned: 300, coinTransferred: 0 } }, { settled: { coin: 300, reputation: 3, ladder: 1 } });
    expect(screen.getByTestId("replay-loot")).toHaveTextContent("Your party earned 300 Coin from this fight.");
    expect(screen.queryByTestId("replay-loot-transferred")).toBeNull();
  });

  it("tells the fight from the party's side: where it came in, its loot, what the ledger credited, what stopped it", async () => {
    const clockStub = stubClock();
    const view = replayOwner();
    const { player } = await renderPlayer(view, { settled: { coin: 0, reputation: 3, ladder: 1 } });
    expect(player).toHaveAttribute("data-viewer", "party_owner");
    expect(screen.getByTestId("replay-intro")).toHaveTextContent("Your standing party was served into someone's trip while you were away. It came in from the north and east.");
    expect(screen.getByTestId("replay-intro")).toHaveTextContent("Your party lost nothing; it is a template.");
    expect(screen.getByTestId("replay-outcome")).toHaveTextContent("Your party was stopped: the caravan held.");
    expect(screen.getByTestId("replay-depth")).toHaveTextContent("Depth: your party got");
    expect(screen.getByTestId("replay-depth")).toHaveTextContent("Deepest: your Dust Rider.");
    expect(screen.getByTestId("replay-loot")).toHaveTextContent(`Your party's loot from this fight: ${view.outcome!.loot} Coin, as reported.`);
    // The ledger's itemization wins over the feed's figures.
    const settled = screen.getByTestId("replay-settled");
    expect(settled).toHaveTextContent(`+${view.outcome!.loot} Coin loot credited.`);
    // Final play-test review D6 (PROJECT.md §10): a held party never lowers its owner's Reputation.
    expect(settled).not.toHaveTextContent("Reputation (siege)");
    expect(settled).toHaveTextContent("Ladder (siege): +10 points.");
    expect(settled).toHaveTextContent("Your party lost nothing: it is a template.");
    expect(settled).not.toHaveTextContent("Credited:");
    expect(screen.getByTestId("replay-tally")).toHaveTextContent("Your raiders down: 2 of 2");
    expect(screen.getByText("What stopped your party")).toBeInTheDocument();
    expect(screen.getByTestId("replay-fates")).toHaveTextContent("Your Dust Rider: fell to the caravan's Well Digger 1 at 0:19.");
    toEndAndHold(clockStub, (view.log as { ticks: number }).ticks);
    expect(screen.getByTestId("replay-feed")).toHaveTextContent("The caravan's Spike Pit sprang on your Well Digger");
    expect(screen.getByTestId("replay-end-card")).toHaveTextContent("Your party was stopped: the caravan held.");
  });
});

describe("a golden log with traps, fence breaks and abilities plays through the player", () => {
  it("combat-full-load-16v8v28: an overrun, fence breaks and nullified traps (no siege labelled: none credited)", async () => {
    const clockStub = stubClock();
    const view = goldenView("combat-full-load-16v8v28");
    await renderPlayer(view);
    expect(screen.getByTestId("replay-outcome")).toHaveTextContent("Your caravan was overrun.");
    expect(screen.getByTestId("replay-depth")).toHaveTextContent("The raiders reached your core.");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-units", "24");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-fences", "28");
    expect(screen.queryByTestId("replay-siege")).toBeNull();
    await userEvent.click(screen.getByTestId("replay-to-end"));
    clockStub.flush(100, 15);
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-fences", "24");
    const feed = screen.getByTestId("replay-feed");
    expect(feed).toHaveTextContent("reached the core.");
    expect(feed).toHaveTextContent(/Your Brush Pile #\d+ broke\./);
    expect(feed).toHaveTextContent("it was made harmless.");
    expect(feed).not.toHaveTextContent("siege");
    expect(screen.getByTestId("replay-end-card")).toHaveTextContent("Your caravan was overrun.");
    const tally = screen.getByTestId("replay-tally");
    expect(tally).toHaveTextContent("The core was reached.");
    // N3: the nullified traps are their own line, not "sprung".
    expect(tally).toHaveTextContent("Traps sprung: 3 of 6");
    expect(tally).toHaveTextContent("Traps made harmless by the party's siege: 3");
    expect(screen.getByTestId("replay-settled")).toHaveTextContent(STRINGS.replay.settledNotYet);
  });

  it("S6: a held fight that ended a hair short of the core never reads 'reached your core'", async () => {
    const base = goldenView("c11-guard-kills-raider-held");
    const log = base.log as { outcome: { depth: number } };
    await renderPlayer(base);
    expect(base.outcome!.kind).toBe("caravan_held");
    expect(screen.getByTestId("replay-depth")).not.toHaveTextContent("reached your core");
    expect(screen.getByTestId("replay-depth")).toHaveTextContent(`${Math.min(99, Math.floor((log.outcome.depth * 100) / 1024))}%`);
  });

  it("N3: no posted units means no '0 of 0' line", async () => {
    await renderPlayer(goldenView("open-field-core"));
    const tally = screen.getByTestId("replay-tally");
    expect(tally).not.toHaveTextContent("0 of 0");
  });
});

describe("states that cannot play", () => {
  it("a fight resolved without a log says so, with the reason under a plain sentence, and still shows the recorded outcome", async () => {
    const view = replayNoLog();
    const { api } = apiFor(view);
    render(<ReplayPlayer jobId={view.jobId} api={api} />);
    const box = await screen.findByTestId("replay-not-renderable");
    expect(box).toHaveAttribute("data-no-log", "true");
    expect(box).toHaveTextContent("No replay was recorded for this fight");
    expect(screen.getByText(STRINGS.replay.reasonDetail)).toBeInTheDocument();
    expect(screen.getByTestId("replay-reason")).toHaveTextContent("Reason: no replay log was recorded for this fight");
    expect(screen.getByTestId("replay-outcome")).toHaveTextContent("Your caravan held.");
    // The ledger's itemization still shows: this double-resolved fight's trip was banked.
    expect(screen.getByTestId("replay-settled")).toHaveTextContent("+600 Coin banked for this encounter.");
    expect(screen.queryByTestId("iso-canvas")).toBeNull();
  });

  it("PHASE-2 §36: a compacted fight shows it was archived, with the outcome and the tally the server kept — never a canvas", async () => {
    const view = replayCompacted();
    const { api } = apiFor(view);
    render(<ReplayPlayer jobId={view.jobId} api={api} />);
    const box = await screen.findByTestId("replay-not-renderable");
    expect(box).toHaveAttribute("data-compacted", "true");
    expect(box).toHaveAttribute("data-no-log", "false");
    expect(box).toHaveTextContent(STRINGS.replay.compactedTitle);
    expect(screen.getByTestId("replay-outcome")).toHaveTextContent("Your caravan held.");
    const t = view.compacted!.tally!;
    const tally = screen.getByTestId("replay-tally");
    expect(tally).toHaveTextContent(`Raiders down: ${t.raidersFallen} of ${t.raiders}`);
    expect(tally).toHaveTextContent(`Your posted units down: ${t.defendersFallen} of ${t.defenders}`);
    expect(screen.getByTestId("replay-depth")).toHaveTextContent(`Deepest: ${t.deepest!.displayName}.`);
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

  it("N7: a body for another fight than the one asked for is refused, never played", async () => {
    const view = replayCaravan();
    const { api } = apiFor(view);
    render(<ReplayPlayer jobId="encounter:00000000-0000-4000-8000-0000000000ff:3" encounterIndex={3} api={api} />);
    expect(await screen.findByTestId("replay-reason")).toHaveTextContent("a different fight");
    expect(screen.queryByTestId("iso-canvas")).toBeNull();
  });

  it.each([
    [409, "not_resolved", "This fight has not been fought out yet."],
    [409, "resolution_unavailable", "This fight could not be resolved and never will be"],
    [410, "replay_expired", "This replay is past its keeping window and has been cleared. Its outcome stays on record in the results you opened it from."],
    [404, "no_replay", "There is no fight to show here."],
  ])("%i %s has its own copy", async (status, code, copy) => {
    const { api } = apiFor(async () => {
      throw new ApiError(status, code, "server message");
    });
    render(<ReplayPlayer jobId="encounter:x:1" api={api} />);
    const box = await screen.findByTestId("replay-unavailable");
    expect(box).toHaveTextContent(copy);
    expect(box).toHaveAttribute("data-code", code);
    // N6: only a fight still being resolved offers Retry.
    if (code === "not_resolved") expect(within(box).getByTestId("replay-retry")).toBeInTheDocument();
    else expect(within(box).queryByTestId("replay-retry")).toBeNull();
  });

  it("N6: 409 not_resolved → Retry asks again and plays once resolved", async () => {
    let n = 0;
    const view = replayCaravan();
    const { api, replay } = apiFor(async () => {
      if (n++ === 0) throw new ApiError(409, "not_resolved", "not yet");
      return view;
    });
    render(<ReplayPlayer jobId={view.jobId} api={api} />);
    await userEvent.click(await screen.findByTestId("replay-retry"));
    expect(await screen.findByTestId("replay-player")).toBeInTheDocument();
    expect(replay).toHaveBeenCalledTimes(2);
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
    const view = { ...replayCaravan(), jobId: enc.result!.jobId, encounterIndex: enc.index };
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

  it("S6: the encounter results never say 'reached the core' for a held fight (depth floored, capped at 99 %)", () => {
    const enc = { ...statusDecide().trip!.encounters[0]!, outcome: "caravan_held" as const, depth: 1021 };
    render(<EncounterResult encounter={enc} />);
    expect(screen.getByTestId("result-depth")).toHaveTextContent("99%");
    expect(screen.getByTestId("result-depth")).not.toHaveTextContent("reached the core");
  });
});

describe("Watch the fight (the party owner's results feed)", () => {
  it("each feed entry with a fight opens it from the party's side, with what the ledger credited", async () => {
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
    expect(within(dialog).getByTestId("replay-settled")).toHaveTextContent("Ladder (siege): +10 points.");
    expect(within(dialog).getByTestId("replay-settled")).not.toHaveTextContent("Reputation (siege)");
  });

  it("before the ledger has the fight, the owner sees the feed's figures", async () => {
    const view = { ...replayOwner(), settled: { ...replayOwner().settled, applied: false } };
    await renderPlayer(view, { settled: { coin: 0, reputation: 3, ladder: 1 } });
    expect(screen.getByTestId("replay-settled")).toHaveTextContent("Credited: 0 Coin · +3 Reputation · +1 ladder.");
  });
});

describe("Recent fights (QA D2): any of the caravan's fights within retention", () => {
  const recent: RecentFightsView = {
    retention: { days: 30, minPerCaravan: 50 },
    encounters: [
      { jobId: replayCaravan().jobId, tripId: "t2", encounterIndex: 1, outcome: "caravan_held", depth: 529, settledAt: "2026-10-11T12:00:00.000Z", replay: "log" },
      { jobId: "encounter:00000000-0000-4000-8000-000000000009:2", tripId: "t1", encounterIndex: 2, outcome: "caravan_overrun", depth: 1024, settledAt: "2026-10-10T12:00:00.000Z", replay: "pruned" },
    ],
  };

  it("loads only when opened, newest first, and opens the player for a fight with a log", async () => {
    const recentFights = vi.fn(async () => recent);
    const view = replayCaravan();
    const replay = vi.fn(async () => view);
    render(<RecentFights api={fakeApi({ recentFights, replay })} />);
    expect(recentFights).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("recent-fights-toggle"));
    const list = await screen.findByTestId("recent-fights-list");
    expect(recentFights).toHaveBeenCalledTimes(1);
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/^Encounter 1 · held · /);
    expect(items[1]).toHaveTextContent("Replay cleared (past its keeping window).");
    expect(within(items[1]!).queryByRole("button")).toBeNull();
    await userEvent.click(within(items[0]!).getByRole("button", { name: "Watch" }));
    const dialog = await screen.findByRole("dialog", { name: "Encounter 1: the fight" });
    expect(replay).toHaveBeenCalledWith(view.jobId);
    expect(await within(dialog).findByTestId("replay-player")).toBeInTheDocument();
  });
});
