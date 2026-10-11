import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { CARAVAN_ID, economyView, fakeApi, meWith, mergePreview, recruitView, refugeeView, uid, type FixtureUnit } from "../../test/townFixtures.ts";
import { RefugeePanel } from "./RefugeePanel.tsx";
import { RecruitPanel } from "./RecruitPanel.tsx";
import { TownScreen } from "./TownScreen.tsx";

// The canvas needs WebGL; in jsdom it is replaced by buttons firing the same callbacks.
vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => (props.state.drag ? 0.38 : 0) }));
    const units = props.state.boardUnits ?? [];
    return (
      <div data-testid="iso-canvas" data-drag={props.state.drag ? "yes" : "no"} data-units={units.length} data-mine={props.state.mine?.active ? "on" : "off"} data-attackers={props.state.attackers.length} data-posts={props.state.posts.length}>
        {units.map((u) => (
          <button key={u.id} type="button" onClick={() => props.onTapEntity?.({ kind: "unit", id: u.id })}>
            {`tap-${u.id}`}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const [a, b] = units;
            if (!a || !b) return;
            props.onDragBegin?.({ kind: "unit", id: a.id });
            const cell = { x: Math.floor(b.pos.x), y: Math.floor(b.pos.y) };
            props.onDragMove?.(cell);
            props.onDragEnd?.(cell);
          }}
        >
          drag-first-onto-second
        </button>
      </div>
    );
  });
  return { ...actual, IsoCanvas };
});

const RIDERS: FixtureUnit[] = [
  { id: uid(1), typeId: "desert.dust_rider", level: 1 },
  { id: uid(2), typeId: "desert.dust_rider", level: 1 },
  { id: uid(3), typeId: "desert.well_digger", level: 1 },
];

function townApi(units: readonly FixtureUnit[] = RIDERS, over: Partial<Api> = {}): Api {
  return fakeApi({
    me: vi.fn(async () => meWith(units)),
    economy: vi.fn(async () => economyView()),
    manifest: vi.fn(async () => {
      throw new ApiError(404, "no_open_manifest", "this caravan is in town with nothing packed");
    }),
    refugees: vi.fn(async () => refugeeView()),
    recruitList: vi.fn(async () => recruitView()),
    ...over,
  });
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => vi.useRealTimers());

describe("TownScreen", () => {
  it("renders a settlement: caravan state, the board with its count, the mine with no upgrade, and navigation", async () => {
    render(<TownScreen api={townApi()} />);
    expect(await screen.findByTestId("town-screen")).toBeInTheDocument();
    expect(screen.getByTestId("caravan-state")).toHaveAttribute("data-state", "in_town");
    expect(screen.getByTestId("caravan-state")).toHaveTextContent("in town, refitting");
    expect(screen.getByTestId("board-count")).toHaveTextContent("3 of 36 board slots used · 0 in overflow");
    const canvas = screen.getByTestId("iso-canvas");
    expect(canvas).toHaveAttribute("data-units", "3");
    expect(canvas).toHaveAttribute("data-drag", "no");
    expect(canvas).toHaveAttribute("data-mine", "on");
    expect(canvas).toHaveAttribute("data-attackers", "0");
    expect(canvas).toHaveAttribute("data-posts", "0");
    const mine = within(screen.getByTestId("mine-panel"));
    expect(mine.getByTestId("mine-balance")).toHaveTextContent("1200 of 50000 Coin stored");
    expect(mine.getByTestId("mine-rate")).toHaveTextContent("200 Coin per hour, ceasing at the cap");
    expect(mine.getByTestId("mine-room")).toHaveTextContent("Room for 48800 more Coin right now.");
    expect(mine.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("mine-panel")).toHaveTextContent("cannot be upgraded");
    const nav = within(screen.getByTestId("town-nav"));
    for (const name of ["Outfit the caravan", "Trail", "Standing raid party", "Unlock webs"]) expect(nav.getByRole("button", { name })).toBeInTheDocument();
    // Nothing on the town screen suggests it can be attacked.
    expect(screen.getByTestId("town-screen").textContent).not.toMatch(/\b(raid(ed)? on (your )?town|defend the town|town (is )?under attack|base)\b/i);
  });

  it("units beyond the board land in the overflow; nothing is refused", async () => {
    const many = Array.from({ length: 38 }, (_, i) => ({ id: uid(i + 1), typeId: "desert.dust_rider", level: 1 }));
    render(<TownScreen api={townApi(many)} />);
    expect(await screen.findByTestId("board-count")).toHaveTextContent("36 of 36 board slots used · 2 in overflow");
    expect(within(screen.getByTestId("overflow-units")).getAllByRole("button")).toHaveLength(2);
  });

  it("drag one unit onto a matching one → the preview quotes cost, balance with pending trickle, stats and slots → confirm commits", async () => {
    const user = userEvent.setup();
    const previewMerge = vi.fn(async (_c: string, ids: readonly string[]) => mergePreview(ids));
    const commitMerge = vi.fn(async () => ({
      replayed: false,
      merged: { unitTypeId: "desert.dust_rider", fromLevel: 1, toLevel: 2, coinCost: 250 },
      consumedInstanceIds: [uid(1), uid(2)],
      producedInstanceIds: [uid(9)],
      produced: [{ id: uid(9), caravan_id: CARAVAN_ID, unit_type_id: "desert.dust_rider", merge_level: 2 }],
      balanceAfter: 950,
    }));
    const me = vi.fn().mockResolvedValueOnce(meWith(RIDERS)).mockResolvedValue(meWith([{ id: uid(9), typeId: "desert.dust_rider", level: 2 }, RIDERS[2]!]));
    render(<TownScreen api={townApi(RIDERS, { previewMerge, commitMerge, me })} />);
    await screen.findByTestId("town-screen");
    await user.click(screen.getByText("drag-first-onto-second"));
    const dialog = await screen.findByRole("dialog", { name: "Merge preview" });
    expect(previewMerge).toHaveBeenCalledWith(CARAVAN_ID, [uid(2), uid(1)]);
    const d = within(dialog);
    expect(await d.findByTestId("merge-cost")).toHaveTextContent("Cost: 250 Coin (250 per resulting unit)");
    expect(d.getByTestId("merge-balance")).toHaveTextContent("Balance: 1200 Coin, including 40 trickled in and not yet written.");
    expect(d.getByTestId("merge-slots")).toHaveTextContent("2 slots become 1: frees 1");
    expect(d.getByTestId("merge-consumed")).toHaveTextContent("800");
    expect(d.getByTestId("merge-produced")).toHaveTextContent("720");
    expect(dialog).toHaveTextContent("not stronger than the consumed ones combined");
    expect(commitMerge).not.toHaveBeenCalled();
    await user.click(d.getByTestId("merge-confirm"));
    expect(commitMerge).toHaveBeenCalledWith(CARAVAN_ID, { instanceIds: [uid(2), uid(1)] });
    expect(await screen.findByTestId("town-status")).toHaveTextContent("Merged: 1 × Dust Rider level 2. 950 Coin left.");
    await waitFor(() => expect(screen.getByTestId("board-count")).toHaveTextContent("2 of 36"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a unit in the standing party needs an explicit confirm, sent as confirmInParty: true", async () => {
    const user = userEvent.setup();
    const previewMerge = vi.fn(async (_c: string, ids: readonly string[]) =>
      mergePreview(ids, { requiresConfirmInParty: true, consumed: { ...mergePreview(ids).consumed, inParty: [uid(1)] } }),
    );
    const commitMerge = vi.fn(async () => {
      throw new ApiError(409, "insufficient_coin", "not enough Coin: 250 needed, 100 available");
    });
    render(<TownScreen api={townApi(RIDERS, { previewMerge, commitMerge })} />);
    await screen.findByTestId("town-screen");
    // Tap, tap: the no-drag way to merge.
    await user.click(screen.getByText(`tap-${uid(1)}`));
    await user.click(screen.getByText(`tap-${uid(2)}`));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByTestId("merge-in-party")).toHaveTextContent("1 of the units to be consumed ride in your standing party");
    expect(dialog.getByTestId("merge-confirm")).toBeDisabled();
    await user.click(dialog.getByTestId("merge-in-party-confirm"));
    expect(dialog.getByTestId("merge-confirm")).toBeEnabled();
    await user.click(dialog.getByTestId("merge-confirm"));
    expect(commitMerge).toHaveBeenCalledWith(CARAVAN_ID, { instanceIds: [uid(2), uid(1)], confirmInParty: true });
    // The server's refusal, verbatim, inside the same dialog.
    expect(await dialog.findByText("not enough Coin: 250 needed, 100 available")).toBeInTheDocument();
    expect(dialog.getByText(/409 insufficient_coin/)).toBeInTheDocument();
  });

  it("the explicit 5 → 3 button opens a preview for five units; an on-trip refusal is shown honestly", async () => {
    const user = userEvent.setup();
    const five = Array.from({ length: 5 }, (_, i) => ({ id: uid(i + 1), typeId: "desert.dust_rider", level: 1 }));
    const previewMerge = vi.fn(async () => {
      throw new ApiError(409, "caravan_on_trip", "units cannot be merged while the caravan is on a trip; nothing is repaired mid-trip");
    });
    render(<TownScreen api={townApi(five, { previewMerge })} />);
    await screen.findByTestId("town-screen");
    const group = within(screen.getByTestId("merge-groups"));
    expect(group.getByTestId("merge-2-1")).toHaveTextContent("Merge 2 → 1 for 250 Coin");
    expect(group.getByTestId("merge-5-3")).toHaveTextContent("Merge 5 → 3 for 750 Coin");
    await user.click(group.getByTestId("merge-5-3"));
    expect(previewMerge).toHaveBeenCalledWith(CARAVAN_ID, [uid(1), uid(2), uid(3), uid(4), uid(5)]);
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("units cannot be merged while the caravan is on a trip; nothing is repaired mid-trip")).toBeInTheDocument();
    expect(dialog.queryByTestId("merge-confirm")).toBeNull();
  });

  it("on a trip: the state says so and merging is not offered", async () => {
    const api = townApi(RIDERS, { me: vi.fn(async () => meWith(RIDERS, "on_trip")) });
    render(<TownScreen api={api} />);
    expect(await screen.findByTestId("caravan-state")).toHaveAttribute("data-state", "on_trip");
    expect(screen.getByTestId("merge-blocked")).toHaveTextContent("Merging waits until the caravan is back in town.");
    for (const b of screen.getAllByTestId("merge-2-1")) expect(b).toBeDisabled();
    expect(screen.getByTestId("nav-outfit")).toBeDisabled();
  });

  it("warns at the cap and stops the mine wheel", async () => {
    render(<TownScreen api={townApi(RIDERS, { economy: vi.fn(async () => economyView({ balance: 50_000, room: 0, atCap: true })) })} />);
    expect(await screen.findByTestId("mine-warn")).toHaveTextContent("At the storage cap");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-mine", "off");
  });
});

describe("RefugeePanel", () => {
  const base = { api: fakeApi(), caravanId: CARAVAN_ID, onView: () => {}, onReload: () => {}, onRosterChanged: () => {} };

  it("collapses duplicates, counts down, and claims with the menu's sequence", async () => {
    const user = userEvent.setup();
    const claimRefugee = vi.fn(async () => ({
      replayed: false,
      acquired: { unitTypeId: "desert.dust_rider", instanceId: uid(5), mergeLevel: 1, source: "refugee", coinCost: 0 },
      refugees: refugeeView({ menu: { claimed: { unitTypeId: "desert.dust_rider", instanceId: uid(5), claimedAtMs: 5 } } }),
    }));
    const onView = vi.fn();
    const onRosterChanged = vi.fn();
    render(<RefugeePanel {...base} api={fakeApi({ claimRefugee })} view={refugeeView()} readAt={1_000} now={() => 1_000} onView={onView} onRosterChanged={onRosterChanged} />);
    const offers = within(screen.getByTestId("refugee-offers"));
    expect(offers.getAllByRole("listitem")).toHaveLength(2);
    expect(offers.getByText("offered 2×")).toBeInTheDocument();
    expect(screen.getByTestId("refugee-panel")).toHaveAttribute("data-timer", "counting");
    expect(screen.getByTestId("refugee-timer")).toHaveTextContent("Next free menu in 1:05");
    expect(screen.getByTestId("refugee-reroll")).toHaveTextContent("New menu now for 150 Coin (reroll 1 this window)");
    await user.click(offers.getByRole("button", { name: "Take Dust Rider" }));
    expect(claimRefugee).toHaveBeenCalledWith(CARAVAN_ID, "desert.dust_rider", 7);
    expect(onView).toHaveBeenCalled();
    expect(onRosterChanged).toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Taken: Dust Rider joined the roster at level 1.");
  });

  it("the countdown running out re-reads the menu (the server decides when it is due)", () => {
    vi.useFakeTimers();
    let t = 0;
    const onReload = vi.fn();
    render(<RefugeePanel {...base} view={refugeeView({ timer: { msUntilFreeRefresh: 2_000 } })} readAt={0} now={() => t} onReload={onReload} />);
    expect(screen.getByTestId("refugee-timer")).toHaveTextContent("0:02");
    t = 2_500;
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId("refugee-panel")).toHaveAttribute("data-timer", "stale");
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("due: the free menu is offered (refresh with fromSequence); a reroll is not offered while it is due", async () => {
    const user = userEvent.setup();
    const refreshRefugees = vi.fn(async () => ({ replayed: false, fromSequence: 7, forfeitedOffers: null, refugees: refugeeView({ menu: { sequence: 8 } }) }));
    render(
      <RefugeePanel
        {...base}
        api={fakeApi({ refreshRefugees })}
        view={refugeeView({ timer: { freeRefreshDue: true, msUntilFreeRefresh: 0 }, reroll: { blockedByFreeRefresh: true } })}
        readAt={0}
        now={() => 0}
      />,
    );
    expect(screen.getByTestId("refugee-panel")).toHaveAttribute("data-timer", "due");
    expect(screen.getByTestId("refugee-timer")).toHaveTextContent("The next free menu is due");
    expect(screen.getByTestId("refugee-reroll-blocked")).toBeInTheDocument();
    expect(screen.queryByTestId("refugee-reroll")).toBeNull();
    await user.click(screen.getByTestId("refugee-refresh"));
    expect(refreshRefugees).toHaveBeenCalledWith(CARAVAN_ID, 7);
  });

  it("reroll: the cost and balance are confirmed in a real modal before anything is spent", async () => {
    const user = userEvent.setup();
    const rerollRefugees = vi.fn(async () => ({ replayed: false, fromSequence: 7, coinCost: 150, balanceAfter: 1050, refugees: refugeeView({ menu: { sequence: 8, origin: "reroll" as const } }) }));
    render(<RefugeePanel {...base} api={fakeApi({ rerollRefugees })} view={refugeeView()} readAt={0} now={() => 0} />);
    await user.click(screen.getByTestId("refugee-reroll"));
    const dialog = screen.getByRole("dialog", { name: "Pay for a sooner menu?" });
    expect(dialog).toHaveTextContent("Spend 150 of 1200 Coin for a new menu now, drawn from the same unlocked pool. This menu's unclaimed offers are forfeited.");
    expect(rerollRefugees).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Spend Coin" }));
    expect(rerollRefugees).toHaveBeenCalledWith(CARAVAN_ID, 7);
    expect(await screen.findByRole("status")).toHaveTextContent("New menu for 150 Coin. 1050 Coin left.");
  });
});

describe("RecruitPanel", () => {
  it("lists every unlocked type at its fixed cost and the locked ones as 'reach it in the Webs'; confirms before buying", async () => {
    const user = userEvent.setup();
    const recruit = vi.fn(async (_c: string, typeId: string) => ({
      replayed: false,
      acquired: { unitTypeId: typeId, instanceId: uid(7), mergeLevel: 1, source: "mercenary", coinCost: 600 },
      coinCost: 600,
      balanceAfter: 600,
      inventory: { count: 4, cap: 200, room: 196, full: false },
    }));
    const onRecruited = vi.fn();
    render(<RecruitPanel api={fakeApi({ recruit })} caravanId={CARAVAN_ID} view={recruitView({ recruitable: [...recruitView().recruitable.slice(0, 1), { ...recruitView().recruitable[1]!, affordable: false }] })} onRecruited={onRecruited} />);
    const list = within(screen.getByTestId("recruit-list"));
    expect(list.getByRole("button", { name: "Recruit Dust Rider for 600 Coin" })).toBeEnabled();
    expect(list.getByRole("button", { name: "Recruit Well Digger for 600 Coin" })).toBeDisabled();
    expect(list.getByText("Not enough Coin")).toBeInTheDocument();
    const locked = within(screen.getByTestId("recruit-locked"));
    expect(locked.getAllByRole("listitem")).toHaveLength(2);
    expect(locked.getAllByText("Not for sale — reach it in the Webs")).toHaveLength(2);
    expect(locked.queryByRole("button")).toBeNull();
    await user.click(list.getByRole("button", { name: "Recruit Dust Rider for 600 Coin" }));
    const dialog = screen.getByRole("dialog", { name: "Recruit a mercenary?" });
    expect(dialog).toHaveTextContent("Spend 600 of 1200 Coin for one level-1 Dust Rider?");
    expect(recruit).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Spend Coin" }));
    expect(recruit).toHaveBeenCalledWith(CARAVAN_ID, "desert.dust_rider", expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(onRecruited).toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Recruited Dust Rider at level 1. 600 Coin left.");
  });
});

