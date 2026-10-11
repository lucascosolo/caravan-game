import { GRID_WIDTH, PARTY_CONFIG_VERSION } from "@caravan/circle";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { PartyConfigBody } from "../../api/types.ts";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { resetViewerState } from "../../auth/session.tsx";
import { fakeApi, partyView, uid } from "../../test/townFixtures.ts";
import { PartyScreen } from "./PartyScreen.tsx";

vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => 0 }));
    const a = props.state.attackers[0];
    const drop = (cell: { x: number; y: number }): void => {
      if (!a) return;
      props.onDragBegin?.({ kind: "attacker", id: a.id });
      props.onDragMove?.(cell);
      props.onDragEnd?.(cell);
    };
    return (
      <div data-testid="iso-canvas" data-attackers={props.state.attackers.length} data-threat={(props.state.threat?.entryEdges ?? []).join(",")}>
        <button type="button" onClick={() => drop({ x: GRID_WIDTH - 1, y: 9 })}>
          drag-first-to-east-band
        </button>
        <button type="button" onClick={() => drop({ x: 16, y: 16 })}>
          drag-first-to-centre
        </button>
      </div>
    );
  });
  return { ...actual, IsoCanvas };
});

function api(over: Partial<Api> = {}): Api {
  return fakeApi({
    party: vi.fn(async () => ({ party: partyView() })),
    partyFeed: vi.fn(async () => ({ entries: [], nextBefore: 0, hasMore: false })),
    ...over,
  });
}

// The unsaved draft is kept in memory across mounts (QA-17 S4); each test starts signed-out-clean.
beforeEach(() => resetViewerState());

describe("PartyScreen", () => {
  it("shows the template rules, the server's validity issues, the roster and the siege counters", async () => {
    render(<PartyScreen api={api()} />);
    expect(await screen.findByTestId("party-screen")).toHaveTextContent("never consumed and never loses a unit");
    const invalid = screen.getByTestId("party-invalid");
    expect(invalid).toHaveTextContent("a standing party needs at least one unit");
    expect(invalid.textContent).not.toContain("party_empty");
    expect(screen.getByTestId("party-caps")).toHaveTextContent("0 of 8 unit slots · 0 of 2 siege slots");
    const roster = within(screen.getByTestId("party-roster"));
    expect(roster.getByRole("button", { name: /Add Dust Rider L2/ })).toBeInTheDocument();
    expect(roster.getByRole("button", { name: /Add Well Digger L1/ })).toHaveTextContent("also packed on the current trip");
    const siege = within(screen.getByTestId("party-siege"));
    expect(siege.getAllByRole("checkbox")[0]).toBeEnabled();
    expect(siege.getAllByRole("checkbox")[1]).toBeDisabled();
    expect(siege.getAllByText(/^Affects: /).length).toBeGreaterThan(0);
    expect(screen.getByTestId("party-feed")).toHaveTextContent("Not served yet.");
    expect(screen.getByTestId("party-save")).toBeDisabled();
  });

  it("composition, stance, a drag onto an entry band (off-band drops refused), then save sends exactly that config", async () => {
    const user = userEvent.setup();
    const saveParty = vi.fn(async (config: PartyConfigBody) => ({ party: partyView({ config, valid: true, issues: [] }) }));
    render(<PartyScreen api={api({ saveParty })} />);
    await screen.findByTestId("party-screen");
    await user.click(within(screen.getByTestId("party-roster")).getByRole("button", { name: /Add Dust Rider L2/ }));
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-attackers", "1");
    const member = within(screen.getByTestId("party-members"));
    expect(member.getByTestId("member-line")).toHaveTextContent(/Enters from the North at \(\d+, 0\)/);
    await user.click(member.getByRole("button", { name: "Core" }));
    expect(member.getByRole("button", { name: "Core" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByText("drag-first-to-centre"));
    expect(member.getByTestId("member-line")).toHaveTextContent("North");
    await user.click(screen.getByText("drag-first-to-east-band"));
    expect(member.getByTestId("member-line")).toHaveTextContent(`Enters from the East at (${GRID_WIDTH - 1}, 9)`);
    // The list alternative to dragging: position along the edge and depth, from selects.
    await user.selectOptions(member.getByTestId("member-along"), "4");
    await user.selectOptions(member.getByTestId("member-depth"), "1");
    expect(member.getByTestId("member-line")).toHaveTextContent(`Enters from the East at (${GRID_WIDTH - 2}, 4)`);
    await user.click(screen.getByText("drag-first-to-east-band"));
    await user.click(within(screen.getByTestId("party-siege")).getAllByRole("checkbox")[0]!);
    expect(screen.getByTestId("party-screen")).toHaveAttribute("data-dirty", "true");
    await user.click(screen.getByTestId("party-save"));
    const sent = saveParty.mock.calls[0]![0];
    expect(sent).toEqual({ v: PARTY_CONFIG_VERSION, units: [{ ref: uid(1), stance: "core", edge: "east", cell: { x: GRID_WIDTH - 1, y: 9 } }], siege: [expect.any(String)] });
    expect(await screen.findByRole("status")).toHaveTextContent("Party saved.");
    expect(screen.getByTestId("party-valid")).toBeInTheDocument();
  });

  it("a refused save shows the server's issue list exactly", async () => {
    const user = userEvent.setup();
    const saveParty = vi.fn(async () => {
      throw new ApiError(400, "invalid_party", "the party cannot stand as configured", undefined, [
        { code: "type_locked", message: "unit type 'desert.dust_rider' is not unlocked", subject: uid(1) },
        { code: "siege_cap", message: "at most 2 siege pieces", subject: "siege" },
      ]);
    });
    render(<PartyScreen api={api({ saveParty })} />);
    await screen.findByTestId("party-screen");
    await user.click(within(screen.getByTestId("party-roster")).getByRole("button", { name: /Add Dust Rider L2/ }));
    await user.click(screen.getByTestId("party-save"));
    const issues = await screen.findByTestId("party-issues");
    // Refs are shown by name, never as raw ids or codes.
    expect(issues).toHaveTextContent("Dust Rider · L2: unit type Dust Rider is not unlocked");
    expect(issues.textContent).not.toMatch(/type_locked|desert\.dust_rider|00000000-/);
    expect(issues).toHaveTextContent("at most 2 siege pieces");
  });
});

describe("PartyScreen — QA-17", () => {
  const entry = (seq: number, outcomeKind: string | null) => ({
    seq,
    occurredAt: "2026-10-11T12:00:00.000Z",
    jobId: null,
    encounterIndex: 1,
    defender: { username: "rival", caravanName: "Their Caravan", regionId: "desert" },
    outcomeKind,
    coinEarned: 0,
    reputationDelta: 0,
    ladderPointsGained: 0,
  });

  it("S4: the feed's Retry re-reads only the feed; the unsaved draft stays", async () => {
    const user = userEvent.setup();
    const party = vi.fn(async () => ({ party: partyView() }));
    const partyFeed = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "unavailable", "down"))
      .mockResolvedValue({ entries: [], nextBefore: 0, hasMore: false });
    render(<PartyScreen api={api({ party, partyFeed })} />);
    await screen.findByTestId("party-screen");
    await user.click(within(screen.getByTestId("party-roster")).getByRole("button", { name: /Add Dust Rider L2/ }));
    expect(screen.getByTestId("party-screen")).toHaveAttribute("data-dirty", "true");
    await user.click(within(screen.getByTestId("party-feed")).getByRole("button", { name: "Retry" }));
    expect(await within(screen.getByTestId("party-feed")).findByText(/Not served yet/)).toBeInTheDocument();
    expect(party).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("party-screen")).toHaveAttribute("data-dirty", "true");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-attackers", "1");
  });

  it("S4: leaving the tab and coming back keeps the unsaved draft", async () => {
    const user = userEvent.setup();
    const first = render(<PartyScreen api={api()} />);
    await screen.findByTestId("party-screen");
    await user.click(within(screen.getByTestId("party-roster")).getByRole("button", { name: /Add Dust Rider L2/ }));
    first.unmount();
    render(<PartyScreen api={api()} />);
    expect(await screen.findByTestId("party-draft-kept")).toHaveTextContent("Unsaved changes kept from earlier");
    expect(screen.getByTestId("party-screen")).toHaveAttribute("data-dirty", "true");
    expect(within(screen.getByTestId("party-members")).getAllByRole("listitem")).toHaveLength(1);
  });

  it("S4: reloading the saved party asks before discarding unsaved edits", async () => {
    const user = userEvent.setup();
    const party = vi.fn(async () => ({ party: partyView() }));
    render(<PartyScreen api={api({ party })} />);
    await screen.findByTestId("party-screen");
    await user.click(within(screen.getByTestId("party-roster")).getByRole("button", { name: /Add Dust Rider L2/ }));
    await user.click(screen.getByTestId("party-reload"));
    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("party-screen")).toHaveAttribute("data-dirty", "true");
    expect(party).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("party-reload"));
    await user.click(within(await screen.findByRole("dialog")).getByTestId("party-discard-confirm"));
    await vi.waitFor(() => expect(screen.getByTestId("party-screen")).toHaveAttribute("data-dirty", "false"));
    expect(party).toHaveBeenCalledTimes(2);
  });

  it("N3: feed outcomes are worded for the player, never the raw kind", async () => {
    const partyFeed = vi.fn(async () => ({ entries: [entry(3, "placeholder_unresolved"), entry(2, "caravan_overrun"), entry(1, "something_new")], nextBefore: 0, hasMore: false }));
    render(<PartyScreen api={api({ partyFeed })} />);
    const feed = await screen.findByTestId("party-feed");
    await within(feed).findByText("Outcome: not fought out yet");
    expect(feed).toHaveTextContent("Outcome: your party overran the caravan");
    expect(feed).toHaveTextContent("Outcome: recorded");
    expect(feed.textContent).not.toMatch(/placeholder_unresolved|caravan_overrun|something_new/);
  });

  it("S7: the siege toggle labels are at least a touch target tall", async () => {
    render(<PartyScreen api={api()} />);
    const siege = await screen.findByTestId("party-siege");
    for (const label of siege.querySelectorAll("label")) expect((label as HTMLElement).style.minHeight).toBe("var(--tap)");
  });
});
