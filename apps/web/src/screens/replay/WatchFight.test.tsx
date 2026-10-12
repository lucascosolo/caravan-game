/**
 * QA-36 S4 / N7: "Watch the fight" loads the replay player as a lazy chunk. While it downloads,
 * the dialog shows the loading line; when the download FAILS, the dialog says so with a Retry that
 * really imports again — the screen behind it (and the app's tab bar) is never replaced by the
 * app-level render error, and a rejected import is not cached.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../shell/ErrorBoundary.tsx";
import { STRINGS } from "../../strings.ts";
import { WatchFight, setReplayPlayerImporterForTests } from "./WatchFight.tsx";

type PlayerModule = typeof import("./ReplayPlayer.tsx");
const fakeModule = { ReplayPlayer: () => <p data-testid="fake-player">the player</p> } as unknown as PlayerModule;

function screenWithFight(): void {
  render(
    <ErrorBoundary onError={() => undefined}>
      <section data-testid="trail-behind">the trail</section>
      <WatchFight jobId="encounter:00000000-0000-4000-8000-000000000001:1" encounterIndex={1} label="Watch the fight" />
    </ErrorBoundary>,
  );
}

afterEach(() => {
  setReplayPlayerImporterForTests();
  vi.restoreAllMocks();
});

describe("WatchFight's lazy replay chunk", () => {
  it("shows the loading line while the chunk downloads, then the player", async () => {
    let finish: (m: PlayerModule) => void = () => undefined;
    setReplayPlayerImporterForTests(() => new Promise<PlayerModule>((r) => (finish = r)));
    screenWithFight();
    await userEvent.click(screen.getByTestId("watch-fight"));
    expect(screen.getByTestId("replay-loading")).toHaveTextContent(STRINGS.replay.loading);
    await act(async () => finish(fakeModule));
    expect(await screen.findByTestId("fake-player")).toBeInTheDocument();
  });

  it("a failed download is shown inside the dialog (the trail stays), and Retry imports again and renders the player", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const importer = vi.fn<() => Promise<PlayerModule>>().mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module")).mockResolvedValue(fakeModule);
    setReplayPlayerImporterForTests(importer);
    screenWithFight();
    await userEvent.click(screen.getByTestId("watch-fight"));
    const err = await screen.findByTestId("replay-chunk-error");
    expect(err).toHaveTextContent(STRINGS.replay.chunkFailedTitle);
    expect(screen.getByTestId("replay-dialog")).toContainElement(err);
    expect(screen.getByTestId("trail-behind")).toBeInTheDocument();
    expect(screen.queryByTestId("render-error")).toBeNull();
    await userEvent.click(screen.getByTestId("replay-chunk-retry"));
    expect(await screen.findByTestId("fake-player")).toBeInTheDocument();
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("closing after a failure and opening again retries the import too (no cached rejection)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const importer = vi.fn<() => Promise<PlayerModule>>().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(fakeModule);
    setReplayPlayerImporterForTests(importer);
    screenWithFight();
    await userEvent.click(screen.getByTestId("watch-fight"));
    await screen.findByTestId("replay-chunk-error");
    await userEvent.click(screen.getByTestId("replay-close"));
    await userEvent.click(screen.getByTestId("watch-fight"));
    expect(screen.queryByTestId("replay-chunk-error")).toBeNull();
    expect(await screen.findByTestId("fake-player")).toBeInTheDocument();
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
