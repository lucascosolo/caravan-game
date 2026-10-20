/**
 * Chunk 29: the Inbox screen and the shell's unread badge. The server decides everything —
 * items, unread, preferences — so these tests drive a fake api and check what is said, what
 * is sent back, and what is never offered (anything that sells).
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { InboxItemView, InboxMarkResult, InboxView } from "../../api/inboxTypes.ts";
import { InboxButton } from "../../shell/InboxButton.tsx";
import { INBOX_POLL_MS, publishUnread } from "../../shell/inboxSignal.ts";
import { fakeApi } from "../../test/townFixtures.ts";
import { InboxScreen } from "./InboxScreen.tsx";

vi.mock("../replay/ReplayPlayer.tsx", () => ({
  ReplayPlayer: ({ jobId }: { jobId: string }) => <div data-testid="replay-player-stub">{jobId}</div>,
}));

const H = 3_600_000;
const T0 = 1_790_000_000_000;

const strike: InboxItemView = {
  key: "strike:497222",
  category: "party_strike",
  version: 41,
  occurredAtMs: T0 + 900_000,
  occurredAt: new Date(T0 + 900_000).toISOString(),
  unread: true,
  detail: {
    count: 3,
    held: 1,
    overran: 2,
    stalemate: 0,
    other: 0,
    coinEarned: 180,
    coinTransferred: 120,
    coinDiscardedAtCap: 0,
    reputationDelta: 9,
    ladderPointsGained: 6,
    windowStartMs: T0,
    windowEndMs: T0 + H,
    linesIncluded: true,
    strikes: [
      { seq: 41, occurredAt: new Date(T0 + 900_000).toISOString(), jobId: "job-41", encounterIndex: 2, outcomeKind: "caravan_overrun", defender: { username: "alice", caravanName: "Dusty Wheels", regionId: "desert" }, coinEarned: 150, coinTransferred: 120, coinDiscardedAtCap: 0, reputationDelta: 6, ladderPointsGained: 4 },
      { seq: 40, occurredAt: new Date(T0 + 600_000).toISOString(), jobId: "job-40", encounterIndex: 1, outcomeKind: "caravan_held", defender: { username: "bob", caravanName: "Long Haul", regionId: "desert" }, coinEarned: 0, coinTransferred: 0, coinDiscardedAtCap: 353, reputationDelta: -1, ladderPointsGained: 2 },
    ],
    notListed: 1,
  },
};

const others: InboxItemView[] = [
  { key: "refugees:c1:1", category: "refugees_arrived", version: 1, occurredAtMs: T0 - 1, occurredAt: new Date(T0 - 1).toISOString(), unread: true, detail: { caravanId: "c1", caravanName: "My Wagons", regionId: "desert", arrivedAtMs: T0 - 1, currentMenuUnclaimed: true } },
  { key: "trip_cap:1", category: "trip_cap_refilled", version: 1, occurredAtMs: T0 - 2, occurredAt: new Date(T0 - 2).toISOString(), unread: false, detail: { available: 3, cap: 3, fullAtMs: T0 - 2 } },
  { key: "mine:0", category: "mine_near_cap", version: 1, occurredAtMs: T0 - 3, occurredAt: new Date(T0 - 3).toISOString(), unread: false, detail: { balance: 46_000, cap: 50_000, atCap: false, thresholdPercent: 90, ratePerHour: 200, capReachedAtMs: T0 + 20 * H } },
  { key: "packs:5", category: "packs_rotated", version: 1, occurredAtMs: T0 - 4, occurredAt: new Date(T0 - 4).toISOString(), unread: false, detail: { weekIndex: 5, startsAtMs: T0 - 4, endsAtMs: T0 + 7 * 24 * H } },
];

const PREFS: InboxView["preferences"] = [
  { category: "party_strike", enabled: true, defaultEnabled: true },
  { category: "refugees_arrived", enabled: false, defaultEnabled: false },
  { category: "trip_cap_refilled", enabled: false, defaultEnabled: false },
  { category: "mine_near_cap", enabled: false, defaultEnabled: false },
  { category: "packs_rotated", enabled: false, defaultEnabled: false },
];

function view(items: readonly InboxItemView[], prefs = PREFS): InboxView {
  return { items, unreadCount: items.filter((i) => i.unread).length, preferences: prefs, olderStrikes: null, strikeBatchWindowMs: H, horizonMs: 14 * 24 * H, delivery: "in_app" };
}

const marked = (v: InboxView): InboxMarkResult => ({ ...v, ignored: [] });
const readAll = (v: InboxView): InboxMarkResult => marked(view(v.items.map((i) => ({ ...i, unread: false }) as InboxItemView), v.preferences));

afterEach(() => {
  vi.useRealTimers();
  window.location.hash = "";
});

describe("InboxScreen", () => {
  it("says what happened, where and what it earned, batched with a count, and never names an account", async () => {
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([strike])) })} />);
    const card = await screen.findByTestId("inbox-item-party_strike");
    expect(card).toHaveAttribute("data-unread", "true");
    expect(card).toHaveTextContent("New");
    expect(card).toHaveTextContent("Your party struck 3 caravans");
    expect(card).toHaveTextContent("2 overrun by your party · 1 held out");
    expect(card).toHaveTextContent("Earned 180 Coin · +9 Reputation · +6 ladder");
    expect(card).toHaveTextContent("Of that, 120 Coin was unbanked Coin the overrun caravans lost to your party.");
    const first = within(screen.getByTestId("inbox-strike-41"));
    expect(first.getByText("vs Dusty Wheels, encounter 2 of their trip")).toBeInTheDocument();
    expect(first.getByText("Your party overran the caravan.")).toBeInTheDocument();
    expect(within(screen.getByTestId("inbox-strike-40")).getByText("The caravan held; your party was driven off.")).toBeInTheDocument();
    expect(card).toHaveTextContent("1 more in this hour are counted above");
    // QA N6: a line says what the storage cap discarded from it, as the batch does.
    expect(within(screen.getByTestId("inbox-strike-40")).getByText(/0 Coin · -1 Reputation \(353 did not fit\)/)).toBeInTheDocument();
    expect(within(screen.getByTestId("inbox-strike-41")).queryByText(/did not fit/)).toBeNull();
    expect(screen.getByTestId("inbox-screen")).toHaveTextContent("nothing is sent to your phone or browser yet");
  });

  it("one tap on Watch the fight opens the replay over the inbox and marks the batch read with the version it showed", async () => {
    const markInboxRead = vi.fn(async () => readAll(view([strike])));
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([strike])), markInboxRead })} />);
    await userEvent.click(await screen.findByTestId("inbox-watch-41"));
    expect(await screen.findByTestId("replay-player-stub")).toHaveTextContent("job-41");
    expect(screen.getByTestId("replay-dialog")).toBeInTheDocument();
    expect(markInboxRead).toHaveBeenCalledWith({ marks: [{ key: "strike:497222", version: 41 }] });
    expect(await screen.findByTestId("inbox-item-party_strike")).toHaveAttribute("data-unread", "false");
    // The dialog survived the re-render that the read mark caused.
    expect(screen.getByTestId("replay-player-stub")).toBeInTheDocument();
  });

  it("marks one, or all, through the server and tells the badge the server's count", async () => {
    const inbox = view([strike, others[0]!]);
    const markInboxRead = vi.fn(async (req: { marks: readonly { key: string }[] }) => (req.marks.length === 1 && req.marks[0]!.key === strike.key ? marked(view([{ ...strike, unread: false }, others[0]!])) : readAll(inbox)));
    render(
      <>
        <InboxButton route="inbox" api={fakeApi({ inboxUnread: vi.fn(async () => ({ unreadCount: 2 })) })} />
        <InboxScreen api={fakeApi({ inbox: vi.fn(async () => inbox), markInboxRead })} />
      </>,
    );
    expect(await screen.findByTestId("inbox-badge")).toHaveTextContent("2");
    await userEvent.click(screen.getByTestId("inbox-mark-strike:497222"));
    expect(markInboxRead).toHaveBeenLastCalledWith({ marks: [{ key: "strike:497222", version: 41 }] });
    expect(await screen.findByTestId("inbox-badge")).toHaveTextContent("1");
    await userEvent.click(screen.getByTestId("inbox-mark-all"));
    // QA S1: exactly the unread items on screen, at the versions shown — never "everything".
    expect(markInboxRead).toHaveBeenLastCalledWith({ marks: [{ key: "refugees:c1:1", version: 1 }] });
    await screen.findByTestId("inbox-items");
    expect(screen.queryByTestId("inbox-badge")).toBeNull();
    expect(screen.queryByTestId("inbox-mark-all")).toBeNull();
    expect(screen.getByTestId("inbox-button")).toHaveAccessibleName("Inbox, nothing new");
  });

  it("the timers: refugees, trip starts, the mine, the packs — stated, and none of them sells anything", async () => {
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([strike, ...others], PREFS.map((p) => ({ ...p, enabled: true })))) })} />);
    expect(await screen.findByTestId("inbox-item-refugees_arrived")).toHaveTextContent("A new free refugee menu is waiting for My Wagons in Town.");
    expect(screen.getByTestId("inbox-item-trip_cap_refilled")).toHaveTextContent("All 3 trip starts are available again.");
    expect(screen.getByTestId("inbox-item-mine_near_cap")).toHaveTextContent("46000 of 50000 Coin stored. The mine adds nothing past the cap.");
    expect(screen.getByTestId("inbox-item-packs_rotated")).toHaveTextContent("only the cosmetics rotate");
    // Never nags toward spending: no store link, no purchase word, no price, no hurry.
    const text = screen.getByTestId("inbox-screen").textContent ?? "";
    expect(text).not.toMatch(/\bbuy\b|purchase|\bspend|\bdeal\b|\boffer|\$|hurry|\bsale\b|\bstore\b|\bshop\b|don't miss|limited/i);
    expect(within(screen.getByTestId("inbox-item-packs_rotated")).queryAllByRole("button")).toEqual([]);
    expect(within(screen.getByTestId("inbox-item-mine_near_cap")).queryAllByRole("button")).toEqual([]);
    await userEvent.click(within(screen.getByTestId("inbox-item-refugees_arrived")).getByRole("button", { name: "Go to Town" }));
    expect(window.location.hash).toBe("#/town");
  });

  it("per-category opt-out: the §29 defaults are shown and a toggle goes to the server", async () => {
    const setInboxPreferences = vi.fn(async () => view([], PREFS.map((p) => (p.category === "refugees_arrived" ? { ...p, enabled: true } : p))));
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([])), setInboxPreferences })} />);
    expect(await screen.findByTestId("inbox-empty")).toHaveTextContent("When your standing party is served into someone's trip");
    await userEvent.click(screen.getByText("What to show here"));
    expect(screen.getByTestId("inbox-pref-party_strike")).toBeChecked();
    expect(screen.getByTestId("inbox-pref-refugees_arrived")).not.toBeChecked();
    expect(screen.getByTestId("inbox-prefs")).toHaveTextContent("Your party struck a caravan (on by default)");
    expect(screen.getByTestId("inbox-prefs")).toHaveTextContent("Refugees arrived (off by default)");
    await userEvent.click(screen.getByTestId("inbox-pref-refugees_arrived"));
    expect(setInboxPreferences).toHaveBeenCalledWith({ refugees_arrived: true });
    expect(await screen.findByTestId("inbox-pref-refugees_arrived")).toBeChecked();
  });

  it("QA S1: \"Mark all read\" sends the versions it is showing, so a strike that arrived since stays unread on the server", async () => {
    const newer = { ...strike, version: 44, detail: { ...strike.detail, count: 4 } };
    const markInboxRead = vi.fn(async () => marked(view([newer])));
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([strike, others[0]!])), markInboxRead })} />);
    await userEvent.click(await screen.findByTestId("inbox-mark-all"));
    expect(markInboxRead).toHaveBeenCalledWith({ marks: [{ key: strike.key, version: 41 }, { key: "refugees:c1:1", version: 1 }] });
    // The server's answer: the batch moved on (v44) and is still unread; the screen shows that.
    expect(await screen.findByTestId("inbox-item-party_strike")).toHaveAttribute("data-unread", "true");
    expect(screen.getByTestId("inbox-item-party_strike")).toHaveTextContent("Your party struck 4 caravans");
  });

  it("QA S4: an older batch arrives without its fights and fetches them when opened", async () => {
    const older: InboxItemView = { ...strike, key: "strike:497200", unread: false, detail: { ...strike.detail, linesIncluded: false, strikes: [] } };
    const inboxStrikes = vi.fn(async () => ({ window: 497200, strikes: strike.detail.strikes }));
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([older])), inboxStrikes })} />);
    const card = await screen.findByTestId("inbox-item-party_strike");
    expect(card).toHaveTextContent("Your party struck 3 caravans");
    expect(within(card).queryByTestId("inbox-watch-41")).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: "Show the fights" }));
    expect(inboxStrikes).toHaveBeenCalledWith(497200);
    expect(await within(card).findByTestId("inbox-watch-41")).toBeInTheDocument();
    expect(within(card).getByText("vs Long Haul, encounter 1 of their trip")).toBeInTheDocument();
  });

  it("QA D2: when batches fall past the 30th or outside the horizon, the list ends by saying so, with the way to the results feed", async () => {
    const v = { ...view([strike]), olderStrikes: { batchesPastLimit: 42, beforeHorizon: true } };
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => v) })} />);
    const older = await screen.findByTestId("inbox-older");
    expect(older).toHaveTextContent("42 earlier hours of strikes and older activity are not listed here. Every strike is in the Party tab's results feed.");
    await userEvent.click(within(older).getByRole("button", { name: "Open the results feed" }));
    expect(window.location.hash).toBe("#/party");
  });

  it("no pointer when nothing is left out", async () => {
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([strike])) })} />);
    await screen.findByTestId("inbox-item-party_strike");
    expect(screen.queryByTestId("inbox-older")).toBeNull();
  });

  it("a load failure shows the server's reason with Retry", async () => {
    const inbox = vi.fn().mockRejectedValueOnce(new ApiError(500, "internal", "internal error")).mockResolvedValueOnce(view([]));
    render(<InboxScreen api={fakeApi({ inbox })} />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("inbox-empty")).toBeInTheDocument();
  });
});

describe("InboxButton (the unread badge)", () => {
  it("shows the server's count in text and words, polls, follows the screen's count, and hides on failure", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const inboxUnread = vi.fn<Api["inboxUnread"]>().mockResolvedValueOnce({ unreadCount: 3 }).mockResolvedValueOnce({ unreadCount: 120 }).mockRejectedValueOnce(new ApiError(0, "network", "down"));
    render(<InboxButton route="town" api={fakeApi({ inboxUnread })} />);
    expect(await screen.findByTestId("inbox-badge")).toHaveTextContent("3");
    expect(screen.getByTestId("inbox-button")).toHaveAccessibleName("Inbox, 3 unread");
    await act(async () => {
      vi.advanceTimersByTime(INBOX_POLL_MS);
    });
    expect(await screen.findByText("99+")).toBeInTheDocument();
    act(() => publishUnread(1));
    expect(screen.getByTestId("inbox-badge")).toHaveTextContent("1");
    await act(async () => {
      vi.advanceTimersByTime(INBOX_POLL_MS);
    });
    expect(screen.queryByTestId("inbox-badge")).toBeNull();
    // QA N7: an unknown count is not "nothing new".
    expect(screen.getByTestId("inbox-button")).toHaveAccessibleName("Inbox");
    expect(inboxUnread).toHaveBeenCalledTimes(3);
  });

  it("opens the inbox route", async () => {
    render(<InboxButton route="town" api={fakeApi({ inboxUnread: vi.fn(async () => ({ unreadCount: 0 })) })} />);
    await userEvent.click(screen.getByTestId("inbox-button"));
    expect(window.location.hash).toBe("#/inbox");
  });
});

describe("final play-test review r4: the inbox's wording", () => {
  it("N8: a strike window still open reads 'Since …'; a closed one 'Between … and …'", async () => {
    const open = { ...strike, detail: { ...strike.detail, windowOpen: true } } as InboxItemView;
    const { unmount } = render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([open])) })} />);
    expect(await screen.findByText(/^Since /)).toBeInTheDocument();
    expect(screen.queryByText(/^Between /)).toBeNull();
    unmount();
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([strike])) })} />);
    expect(await screen.findByText(/^Between /)).toBeInTheDocument();
  });

  it("N6: several merges in one visit are one notice with the final count", async () => {
    const changed: InboxItemView = { key: "party:9", category: "party_changed", version: 4, occurredAtMs: T0, occurredAt: new Date(T0).toISOString(), unread: true, detail: { reason: "merge", carriedOver: 4, dropped: 0, unitsNow: 3, empty: false, changes: 4 } };
    render(<InboxScreen api={fakeApi({ inbox: vi.fn(async () => view([changed])) })} />);
    expect(await screen.findByText(/4 merges used units from your party\./)).toHaveTextContent("It now fields 3 units.");
  });
});
