import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { ACCOUNT_ID, CARAVAN_ID, economyView, fakeApi, meWith, mergePreview, recruitView, refugeeView, uid, type FixtureUnit } from "../../test/townFixtures.ts";
import { capRefused, statusArranging, statusPacked, statusResolving, withCap } from "../../test/tripFixtures.ts";
import { RefugeePanel } from "./RefugeePanel.tsx";
import { RideOutPanel } from "./RideOutPanel.tsx";
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
    tripStatus: vi.fn(async () => statusPacked()),
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
    expect(d.getByTestId("merge-balance")).toHaveTextContent("Balance: 1200 Coin, including the trickle so far (40).");
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
    const api = townApi(RIDERS, { me: vi.fn(async () => meWith(RIDERS, "on_trip")), tripStatus: vi.fn(async () => statusArranging(1)) });
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
    expect(screen.getByTestId("refugee-timer")).toHaveTextContent("Next free menu in 1 min 5 s");
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
    expect(screen.getByTestId("refugee-timer")).toHaveTextContent("2 s");
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
    const refugees = vi.fn(async () => refugeeView());
    render(<RefugeePanel {...base} api={fakeApi({ rerollRefugees, refugees })} view={refugeeView()} readAt={0} now={() => 0} />);
    await user.click(screen.getByTestId("refugee-reroll"));
    const dialog = await screen.findByRole("dialog", { name: "Pay for a sooner menu?" });
    expect(refugees).toHaveBeenCalledTimes(1);
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
    const recruitList = vi.fn(async () => recruitView());
    render(<RecruitPanel api={fakeApi({ recruit, recruitList })} caravanId={CARAVAN_ID} view={recruitView({ recruitable: [...recruitView().recruitable.slice(0, 1), { ...recruitView().recruitable[1]!, affordable: false }] })} onRecruited={onRecruited} />);
    const list = within(screen.getByTestId("recruit-list"));
    expect(list.getByRole("button", { name: "Recruit Dust Rider for 600 Coin" })).toBeEnabled();
    expect(list.getByRole("button", { name: "Recruit Well Digger for 600 Coin" })).toBeDisabled();
    expect(list.getByText("Not enough Coin")).toBeInTheDocument();
    const locked = within(screen.getByTestId("recruit-locked"));
    expect(locked.getAllByRole("listitem")).toHaveLength(2);
    expect(locked.getAllByText("Not for sale — reach it in the Webs")).toHaveLength(2);
    expect(locked.queryByRole("button")).toBeNull();
    await user.click(list.getByRole("button", { name: "Recruit Dust Rider for 600 Coin" }));
    const dialog = await screen.findByRole("dialog", { name: "Recruit a mercenary?" });
    expect(recruitList).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveTextContent("Spend 600 of 1200 Coin for one level-1 Dust Rider?");
    expect(recruit).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Spend Coin" }));
    expect(recruit).toHaveBeenCalledWith(CARAVAN_ID, "desert.dust_rider", expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(onRecruited).toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Recruited Dust Rider at level 1. 600 Coin left.");
  });
});


// ── QA-17 punch list (roadmap/qa/17-punchlist.md) ────────────────────────────────────

describe("QA-17", () => {
  const lostAnswer = (): ApiError => new ApiError(0, "network", "fetch failed");

  it("S2 + N5: recruit re-reads the quote first; a lost answer keeps the dialog with the same requestId and 'Try again' replays it", async () => {
    const user = userEvent.setup();
    let n = 0;
    const recruit = vi.fn(async (_c: string, typeId: string, _requestId: string) => {
      n += 1;
      if (n === 1) throw lostAnswer();
      return { replayed: true, acquired: { unitTypeId: typeId, instanceId: uid(7), mergeLevel: 1, source: "mercenary", coinCost: 600 }, coinCost: 600, balanceAfter: 300, inventory: { count: 4, cap: 200, room: 196, full: false } };
    });
    // The list the panel was rendered with says 1200; the fresh read says 900 — the confirm quotes 900.
    const recruitList = vi.fn(async () => recruitView({ balance: 900 }));
    const onRecruited = vi.fn();
    render(<RecruitPanel api={fakeApi({ recruit, recruitList })} caravanId={CARAVAN_ID} view={recruitView()} onRecruited={onRecruited} />);
    await user.click(within(screen.getByTestId("recruit-list")).getByRole("button", { name: "Recruit Dust Rider for 600 Coin" }));
    const dialog = await screen.findByRole("dialog", { name: "Recruit a mercenary?" });
    expect(dialog).toHaveTextContent("Spend 600 of 900 Coin");
    await user.click(within(dialog).getByTestId("recruit-confirm"));
    // Still open, says "could not confirm" (never "refused" / "Nothing was changed").
    const lost = await within(dialog).findByTestId("spend-unconfirmed");
    expect(lost).toHaveTextContent("Could not confirm whether this went through");
    expect(lost).toHaveTextContent("not charged twice");
    expect(dialog.textContent).not.toMatch(/refused|Nothing was changed/);
    expect(within(dialog).getByTestId("recruit-confirm")).toHaveTextContent("Try again");
    await user.click(within(dialog).getByTestId("recruit-confirm"));
    expect(recruit).toHaveBeenCalledTimes(2);
    expect(recruit.mock.calls[1]![2]).toBe(recruit.mock.calls[0]![2]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("status")).toHaveTextContent("had already gone through; nothing was charged twice");
    expect(onRecruited).toHaveBeenCalled();
  });

  it("S2: a real refusal closes the dialog and shows the server's message", async () => {
    const user = userEvent.setup();
    const recruit = vi.fn(async () => {
      throw new ApiError(409, "insufficient_coin", "not enough Coin: 600 needed, 100 available");
    });
    render(<RecruitPanel api={fakeApi({ recruit, recruitList: vi.fn(async () => recruitView()) })} caravanId={CARAVAN_ID} view={recruitView()} onRecruited={() => {}} />);
    await user.click(within(screen.getByTestId("recruit-list")).getByRole("button", { name: "Recruit Dust Rider for 600 Coin" }));
    await user.click(within(await screen.findByRole("dialog")).getByTestId("recruit-confirm"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("recruit-panel")).toHaveTextContent("not enough Coin: 600 needed, 100 available");
  });

  it("S2: a reroll whose answer is lost stays open; 'Try again' resends the same fromSequence", async () => {
    const user = userEvent.setup();
    const rerollRefugees = vi
      .fn()
      .mockRejectedValueOnce(lostAnswer())
      .mockResolvedValue({ replayed: true, fromSequence: 7, coinCost: 150, balanceAfter: 1050, refugees: refugeeView({ menu: { sequence: 8, origin: "reroll" as const } }) });
    render(<RefugeePanel api={fakeApi({ rerollRefugees, refugees: vi.fn(async () => refugeeView()) })} caravanId={CARAVAN_ID} view={refugeeView()} readAt={0} now={() => 0} onView={() => {}} onReload={() => {}} onRosterChanged={() => {}} />);
    await user.click(screen.getByTestId("refugee-reroll"));
    const dialog = await screen.findByRole("dialog", { name: "Pay for a sooner menu?" });
    await user.click(within(dialog).getByTestId("reroll-confirm"));
    expect(await within(dialog).findByTestId("spend-unconfirmed")).toHaveTextContent("Could not confirm");
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(rerollRefugees).toHaveBeenCalledTimes(2);
    expect(rerollRefugees.mock.calls.map((c) => c[1])).toEqual([7, 7]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("status")).toHaveTextContent("nothing was charged twice");
  });

  it("S2: a claim whose answer is lost offers 'Try again' with the same sequence", async () => {
    const user = userEvent.setup();
    const claimRefugee = vi
      .fn()
      .mockRejectedValueOnce(lostAnswer())
      .mockResolvedValue({ replayed: true, acquired: { unitTypeId: "desert.dust_rider", instanceId: uid(5), mergeLevel: 1, source: "refugee", coinCost: 0 }, refugees: refugeeView() });
    render(<RefugeePanel api={fakeApi({ claimRefugee })} caravanId={CARAVAN_ID} view={refugeeView()} readAt={0} now={() => 0} onView={() => {}} onReload={() => {}} onRosterChanged={() => {}} />);
    await user.click(within(screen.getByTestId("refugee-offers")).getByRole("button", { name: "Take Dust Rider" }));
    const lost = await screen.findByTestId("refugee-lost");
    expect(lost).toHaveTextContent("Could not confirm");
    await user.click(within(lost).getByTestId("refugee-try-again"));
    expect(claimRefugee.mock.calls.map((c) => c[2])).toEqual([7, 7]);
    expect(await screen.findByRole("status")).toHaveTextContent("nothing was taken twice");
  });

  it("S5: claimed and due says the next menu is ready and nothing is forfeited, with no 'on the timer' line", () => {
    render(
      <RefugeePanel
        api={fakeApi()}
        caravanId={CARAVAN_ID}
        view={refugeeView({ menu: { claimed: { unitTypeId: "desert.dust_rider", instanceId: uid(5), claimedAtMs: 5 } }, timer: { freeRefreshDue: true, msUntilFreeRefresh: 0 }, reroll: { blockedByFreeRefresh: true } })}
        readAt={0}
        now={() => 0}
        onView={() => {}}
        onReload={() => {}}
        onRosterChanged={() => {}}
      />,
    );
    const panel = screen.getByTestId("refugee-panel");
    expect(screen.getByTestId("refugee-timer")).toHaveTextContent("Your next free menu is ready: take it now (nothing is forfeited).");
    expect(screen.getByTestId("refugee-claimed").textContent).toBe("This menu's pick was Dust Rider.");
    expect(screen.getByTestId("refugee-timer").textContent).not.toMatch(/forfeits this one/);
    expect(panel).not.toHaveTextContent("The next menu arrives on the timer.");
  });

  it("S3: a failed re-read after a recruit is shown above the board, with the last good board still drawn", async () => {
    const user = userEvent.setup();
    const me = vi.fn().mockResolvedValueOnce(meWith(RIDERS)).mockRejectedValue(new ApiError(503, "unavailable", "down"));
    const recruit = vi.fn(async (_c: string, typeId: string) => ({ replayed: false, acquired: { unitTypeId: typeId, instanceId: uid(7), mergeLevel: 1, source: "mercenary", coinCost: 600 }, coinCost: 600, balanceAfter: 600, inventory: { count: 4, cap: 200, room: 196, full: false } }));
    render(<TownScreen api={townApi(RIDERS, { me, recruit })} />);
    await screen.findByTestId("town-screen");
    await user.click(within(screen.getByTestId("recruit-list")).getByRole("button", { name: "Recruit Dust Rider for 600 Coin" }));
    await user.click(within(await screen.findByRole("dialog")).getByTestId("recruit-confirm"));
    const box = await screen.findByTestId("town-reload-error");
    expect(box).toHaveTextContent("Could not re-read the town");
    expect(box).toHaveTextContent("down");
    expect(within(box).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByTestId("board-count")).toHaveTextContent("3 of 36");
  });

  it("S6: selecting a unit shows the lattice and board cells (a placement ghost with no cell); deselecting hides them", async () => {
    const user = userEvent.setup();
    render(<TownScreen api={townApi()} />);
    await screen.findByTestId("town-screen");
    const canvas = screen.getByTestId("iso-canvas");
    expect(canvas).toHaveAttribute("data-drag", "no");
    await user.click(screen.getByText(`tap-${uid(3)}`));
    expect(canvas).toHaveAttribute("data-drag", "yes");
    await user.click(screen.getByText(`tap-${uid(3)}`));
    expect(canvas).toHaveAttribute("data-drag", "no");
  });

  it("D1: the board layout is stored under the account AND the caravan, and sign-out's reset removes it", async () => {
    const { resetViewerState } = await import("../../auth/session.tsx");
    const { boardStorageKey } = await import("./townScene.ts");
    render(<TownScreen api={townApi()} />);
    await screen.findByTestId("town-screen");
    const key = boardStorageKey(ACCOUNT_ID, CARAVAN_ID);
    expect(key).toContain(ACCOUNT_ID);
    expect(key).toContain(CARAVAN_ID);
    expect(window.localStorage.getItem(key)).not.toBeNull();
    window.localStorage.setItem("unrelated", "kept");
    resetViewerState();
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("kept");
  });

  it("N2: the merge balance names the trickle only when some is pending", async () => {
    const user = userEvent.setup();
    const previewMerge = vi.fn(async (_c: string, ids: readonly string[]) => mergePreview(ids, { pendingTrickle: 0 }));
    render(<TownScreen api={townApi(RIDERS, { previewMerge })} />);
    await screen.findByTestId("town-screen");
    await user.click(screen.getByText("drag-first-onto-second"));
    const balance = await within(await screen.findByRole("dialog")).findByTestId("merge-balance");
    expect(balance.textContent).toBe("Balance: 1200 Coin.");
  });
});

describe("Town: the caravan's state from the trip loop, the trip cap and riding out (chunk 23)", () => {
  function packedManifest() {
    const body = { v: 1, units: [{ ref: uid(1), typeId: "desert.dust_rider", mergeLevel: 1, maxHp: 620, hp: 620 }], traps: [], fences: [] };
    return { manifest: { id: uid(500), caravanId: CARAVAN_ID, encountersResolved: 0, createdAt: "", closedAt: null, packed: body, survivors: body, summary: { unitsAlive: 1, unitsDead: 0, trapsUnspent: 0, trapsSpent: 0, fencesIntact: 0, fencesDestroyed: 0 }, formations: [] } };
  }

  it("in town: the cap line says how many trips are available (one spent after a trip, with the regen countdown)", async () => {
    const spent = withCap(statusPacked(), { available: 2, nextRegenAtMs: statusPacked().nowMs + 125_000, fullAtMs: statusPacked().nowMs + 125_000 });
    render(<TownScreen api={townApi(RIDERS, { tripStatus: vi.fn(async () => spent) })} />);
    const cap = await screen.findByTestId("trip-cap");
    expect(cap).toHaveTextContent("Trips available: 2 of 3. The next trip returns in 2 min 5 s.");
    expect(screen.queryByTestId("ride-out")).toBeNull();
  });

  it("packed but not ridden out: 'Packed, waiting to ride out' with Ride out behind a real modal → POST start → the trail", async () => {
    const user = userEvent.setup();
    const startTrip = vi.fn(async () => ({ tripId: uid(900), manifestId: uid(500), cap: statusResolving().cap, status: statusResolving() }));
    const api = townApi(RIDERS, { manifest: vi.fn(async () => packedManifest()) as unknown as Api["manifest"], startTrip });
    render(<TownScreen api={api} />);
    expect(await screen.findByTestId("caravan-state")).toHaveAttribute("data-state", "packed");
    expect(screen.getByTestId("caravan-state")).toHaveTextContent("Packed, waiting to ride out.");
    const panel = screen.getByTestId("ride-out");
    expect(within(panel).getByTestId("trip-cap")).toHaveTextContent("Trips available: 3 of 3.");
    await user.click(within(panel).getByTestId("ride-out-open-confirm"));
    const dialog = screen.getByRole("dialog", { name: "Ride out now?" });
    expect(dialog).toHaveTextContent("This uses 1 of your 3 available trips (of 3).");
    expect(startTrip).not.toHaveBeenCalled();
    await user.click(within(dialog).getByTestId("ride-out-confirm"));
    expect(startTrip).toHaveBeenCalledWith(CARAVAN_ID);
    await waitFor(() => expect(window.location.hash).toBe("#/trail"));
    window.location.hash = "";
  });
});

describe("RideOutPanel: unpack (final play-test review N9)", () => {
  it("packed with no trip available is never a dead end: Unpack asks the server to close the unused manifest and the town re-reads", async () => {
    const user = userEvent.setup();
    const unpackManifest = vi.fn(async () => ({ unpacked: { manifestId: uid(500) } }));
    const onUnpacked = vi.fn();
    const s = withCap(statusPacked(), { available: 0, nextRegenAtMs: statusPacked().nowMs + 90_000, fullAtMs: statusPacked().nowMs + 90_000 });
    render(<RideOutPanel api={fakeApi({ unpackManifest })} caravanId={CARAVAN_ID} status={s} onStarted={() => {}} onUnpacked={onUnpacked} />);
    expect(screen.getByTestId("ride-out-open-confirm")).toBeDisabled();
    await user.click(screen.getByTestId("ride-out-unpack"));
    expect(unpackManifest).toHaveBeenCalledWith(CARAVAN_ID);
    expect(onUnpacked).toHaveBeenCalled();
  });

  it("without an onUnpacked handler there is no Unpack button", () => {
    render(<RideOutPanel api={fakeApi()} caravanId={CARAVAN_ID} status={statusPacked()} onStarted={() => {}} />);
    expect(screen.queryByTestId("ride-out-unpack")).toBeNull();
  });
});

describe("RideOutPanel (chunk 23)", () => {
  it("counts the regen from SERVER time: a device clock 10 minutes fast cannot open it early", async () => {
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60_000;
    try {
      const s = withCap(statusPacked(), { available: 0, nextRegenAtMs: statusPacked().nowMs + 90_000, fullAtMs: statusPacked().nowMs + 90_000 });
      render(<RideOutPanel api={fakeApi()} caravanId={CARAVAN_ID} status={s} onStarted={() => {}} />);
      expect(screen.getByTestId("trip-cap")).toHaveTextContent("The next trip returns in 1 min 30 s.");
      expect(Number(screen.getByTestId("trip-cap").getAttribute("data-seconds-left"))).toBeGreaterThanOrEqual(89);
      expect(screen.getByTestId("ride-out-open-confirm")).toBeDisabled();
    } finally {
      Date.now = realNow;
    }
  });

  it("refusals are the server's: trip_cap_exhausted counts down from retryAfterSeconds; trip_open points at the trail; not_packed says so", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<RideOutPanel api={fakeApi()} caravanId={CARAVAN_ID} status={statusPacked()} initialError={capRefused()} onStarted={() => {}} />);
    expect(screen.getByTestId("ride-out-refused")).toHaveTextContent("No trip is available right now. The next one returns in 20 min");
    expect(screen.getByTestId("ride-out-open-confirm")).toBeDisabled();
    unmount();
    const startTrip = vi.fn(async () => {
      throw new ApiError(409, "trip_open", "this caravan is already on a trip");
    });
    render(<RideOutPanel api={fakeApi({ startTrip })} caravanId={CARAVAN_ID} status={statusPacked()} onStarted={() => {}} />);
    await user.click(screen.getByTestId("ride-out-open-confirm"));
    await user.click(screen.getByTestId("ride-out-confirm"));
    expect(await screen.findByTestId("ride-out-open")).toHaveTextContent("The caravan is already on a trip.");
    expect(within(screen.getByTestId("ride-out-open")).getByRole("button", { name: "To the trail" })).toBeInTheDocument();
  });

  it("a lost start answer keeps the dialog; Try again that finds the trip open says it went through (never counted twice)", async () => {
    const user = userEvent.setup();
    let n = 0;
    const startTrip = vi.fn(async () => {
      n++;
      if (n === 1) throw new ApiError(0, "network", "fetch failed");
      throw new ApiError(409, "trip_open", "this caravan is already on a trip");
    });
    const onStarted = vi.fn();
    render(<RideOutPanel api={fakeApi({ startTrip })} caravanId={CARAVAN_ID} status={statusPacked()} onStarted={onStarted} />);
    await user.click(screen.getByTestId("ride-out-open-confirm"));
    await user.click(screen.getByTestId("ride-out-confirm"));
    expect(await screen.findByTestId("ride-out-unconfirmed")).toHaveTextContent("Could not confirm whether the caravan rode out");
    expect(screen.getByTestId("ride-out-confirm")).toHaveTextContent("Try again");
    await user.click(screen.getByTestId("ride-out-confirm"));
    expect(onStarted).toHaveBeenCalledWith(null, true);
    expect(startTrip).toHaveBeenCalledTimes(2);
  });
});
