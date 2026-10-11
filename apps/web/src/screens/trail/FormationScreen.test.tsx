import { EMPTY_FORMATION, ringSegment, serializeFormation, formationGaps, CORE_CELLS, type Formation } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, BAD_PAYLOAD, type Api } from "../../api/client.ts";
import type { ManifestView } from "../../api/types.ts";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { survivorsManifest } from "../../test/circleFixtures.ts";
import { FormationScreen, clearLocalDrafts } from "./FormationScreen.tsx";
import { fixtureEncounter } from "./scoutFixture.ts";

// The canvas needs WebGL; in jsdom it is replaced by buttons that fire the same callbacks
// the real one fires from taps. Placement logic is in placement.ts and tested there. The
// mock's handle says the whole viewport is the canvas and every point is cell (12, 12), so
// tray drags can be driven with plain pointer events.
vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(props, ref) {
    useImperativeHandle(ref, () => ({
      clientToCell: () => ({ x: 12, y: 12 }),
      cellToClient: () => null,
      isOverCanvas: (_x: number, y: number) => y < 100,
      latticeAlpha: () => (props.state.drag || props.state.placing ? 0.38 : 0),
      zoom: () => 1,
      pixiAccessibility: () => false,
    }));
    const attacker = props.state.attackers[0];
    return (
      <div
        data-testid="iso-canvas"
        data-drag={props.state.drag ? "yes" : "no"}
        data-placing={props.state.placing ?? "none"}
        data-focus={props.focus?.key ?? "none"}
        data-posts={props.state.posts.length}
        data-fences={props.state.fences.length}
        data-attackers={props.state.attackers.length}
        data-radii={JSON.stringify(props.state.posts.map((p) => [p.aggroRadius, p.leashDistance, p.attackRange]))}
      >
        <button type="button" onClick={() => props.onTapCell?.({ x: 12, y: 12 })}>
          tap-12-12
        </button>
        <button type="button" onClick={() => props.onTapCell?.(CORE_CELLS[0]!)}>
          tap-core
        </button>
        <button type="button" onClick={() => props.onTapCell?.(ringSegment(3).cell)}>
          tap-ring-3
        </button>
        <button type="button" onClick={() => props.onTapEntity?.({ kind: "post", id: "u-rider" })}>
          tap-u-rider
        </button>
        {attacker && (
          <button type="button" onClick={() => props.onTapEntity?.({ kind: "attacker", id: attacker.id })}>
            tap-attacker
          </button>
        )}
        <button type="button" onClick={() => props.onDragBegin?.({ kind: "post", id: "u-rider" })}>
          drag-begin-rider
        </button>
        <button type="button" onClick={() => props.onDragCancel?.()}>
          drag-cancel
        </button>
      </div>
    );
  });
  return { ...actual, IsoCanvas };
});

function fakeApi(over: Partial<Api> = {}): Api {
  const notCalled = () => Promise.reject(new Error("not expected"));
  return {
    register: notCalled,
    login: notCalled,
    logout: notCalled,
    me: notCalled,
    unlocks: notCalled,
    progression: notCalled,
    spendUnlock: notCalled,
    packManifest: notCalled,
    manifest: notCalled,
    saveFormation: notCalled,
    formation: notCalled,
    commitFormation: notCalled,
    searchCandidates: notCalled,
    candidates: notCalled,
    chooseCandidate: notCalled,
    tripStatus: notCalled,
    startTrip: notCalled,
    commitEncounter: notCalled,
    tripPreview: notCalled,
    pushTrip: notCalled,
    bankTrip: notCalled,
    economy: notCalled,
    previewMerge: notCalled,
    commitMerge: notCalled,
    refugees: notCalled,
    claimRefugee: notCalled,
    refreshRefugees: notCalled,
    rerollRefugees: notCalled,
    recruitList: notCalled,
    recruit: notCalled,
    party: notCalled,
    saveParty: notCalled,
    partyFeed: notCalled,
    store: notCalled,
    purchasePack: notCalled,
    storePurchases: notCalled,
    cosmetics: notCalled,
    equipCosmetic: notCalled,
    unequipCosmetic: notCalled,
    replay: notCalled,
    inbox: notCalled,
    inboxUnread: notCalled,
    markInboxRead: notCalled,
    inboxStrikes: notCalled,
    setInboxPreferences: notCalled,
    onboarding: notCalled,
    advanceOnboarding: notCalled,
    skipOnboarding: notCalled,
    ...over,
  };
}

function trip(): ManifestView {
  const survivors = survivorsManifest();
  return { id: "m1", caravanId: "c1", encountersResolved: 2, createdAt: "", closedAt: null, packed: survivors, survivors, summary: { unitsAlive: 2, unitsDead: 1, trapsUnspent: 1, trapsSpent: 1, fencesIntact: 19, fencesDestroyed: 1 }, formations: [] };
}

function formationView(f: Formation, committedAt: string | null) {
  return { formation: { manifestId: "m1", encounterIndex: 3, formation: f, hash: "h", gaps: [...formationGaps(f)], committedAt } };
}

const scout = fixtureEncounter(3);
const NO_AUTOSAVE = 3_600_000;

function screenWith(api: Api, extra: { autosaveMs?: number; initial?: ReturnType<typeof formationView>["formation"] | null; onCommitted?: () => void } = {}) {
  return (
    <FormationScreen
      api={api}
      caravanId="c1"
      trip={trip()}
      encounterIndex={3}
      initial={extra.initial ?? null}
      scout={scout}
      autosaveMs={extra.autosaveMs ?? NO_AUTOSAVE}
      {...(extra.onCommitted ? { onCommitted: extra.onCommitted } : {})}
    />
  );
}

// jsdom has no PointerEvent: a MouseEvent carrying pointerId / pointerType is enough for the tray's listeners.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
}

beforeEach(() => clearLocalDrafts());

describe("FormationScreen", () => {
  it("shows what survives truthfully: a dead unit, a spent trap, a chipped and a destroyed segment, and the attackers", () => {
    render(screenWith(fakeApi()));
    expect(screen.getByRole("heading", { name: "Encounter 3" })).toBeInTheDocument();
    const tray = within(screen.getByTestId("manifest-tray"));
    expect(tray.getByTestId("tray-unit-u-digger")).toHaveTextContent("Dead — lost earlier this trip");
    expect(tray.getByTestId("tray-unit-u-rider")).toHaveTextContent(/206 \/ 620 HP/);
    expect(tray.getByTestId("tray-trap-t0")).toHaveTextContent("Spent — traps fire once and do not re-arm this trip");
    expect(tray.getByTestId("tray-trap-t1")).toHaveTextContent("Fires once; does not re-arm this trip.");
    expect(tray.getByTestId("fence-tray-line")).toHaveTextContent(`${TUNABLES.FENCE_MATERIAL_BUDGET - 1} in the wagon · 0 on the ring · 1 destroyed · ${TUNABLES.FENCE_MATERIAL_BUDGET} packed`);
    expect(tray.getByTestId("tray-fence-f1")).toHaveTextContent("Segment 2: 120 / 300 HP");
    expect(tray.getByTestId("tray-fence-f0")).toHaveTextContent("Destroyed earlier this trip");
    // N7: destroyed segments have their own heading.
    expect(tray.getByTestId("fence-destroyed-heading")).toHaveTextContent("Destroyed segments");
    expect(screen.getByTestId("iso-canvas").getAttribute("data-attackers")).toBe(String(scout.scout.units.length));
    // Both ratings for a defender, defense emphasized.
    const pair = tray.getAllByRole("group", { name: /Offense 95, Defense 83/ })[0]!;
    expect(pair.querySelector(".statpair__stat--big .statpair__lbl")?.textContent).toBe("Defense");
    // N2: a chip's accessible name is its content.
    for (const b of screen.getByTestId("manifest-tray").querySelectorAll(".chip__btn")) expect(b.hasAttribute("aria-label")).toBe(false);
    // S15: no raw refs in what the tray says.
    expect(screen.getByTestId("manifest-tray").textContent).not.toMatch(/\b(f\d+|t\d+|u-[a-z]+)\b/);
    // The scouting panel is on the screen before anything is committed.
    expect(screen.getByTestId("scout-panel")).toBeInTheDocument();
    expect(screen.getByTestId("budget-meter")).toHaveTextContent(`0 of ${TUNABLES.FENCE_MATERIAL_BUDGET - 1} segments placed · 28 ring positions`);
    expect(screen.getByTestId("gaps-line")).toHaveTextContent("28 open positions");
  });

  it("places by tap: select a unit, tap a cell; stance picker appears; stance changes; take back", async () => {
    const user = userEvent.setup();
    render(screenWith(fakeApi()));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    expect(screen.getByTestId("tap-to-place-hint")).toHaveTextContent("Dust Rider selected");
    // D5: a selected tray item counts as "being placed" — the lattice shows; S10: the canvas zooms to the ring.
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-placing", "post");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-focus", "u-rider");
    await user.click(screen.getByText("tap-12-12"));
    expect(screen.getByTestId("iso-canvas").getAttribute("data-posts")).toBe("1");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-placing", "none");
    expect(screen.getByTestId("tray-unit-u-rider")).toHaveTextContent("Posted at (12, 12)");
    const picker = within(screen.getByTestId("stance-picker"));
    expect(picker.getByRole("radio", { name: "Guard" })).toHaveAttribute("aria-checked", "true");
    await user.click(picker.getByRole("radio", { name: "Hold" }));
    expect(picker.getByRole("radio", { name: "Hold" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Fights only what comes within attack reach of the post. Never leaves it.")).toBeInTheDocument();
    await user.click(picker.getByRole("radio", { name: "Reserve" }));
    expect(screen.getByText(/Holds its post and strikes only what comes into attack reach until an attacker breaches the ring/)).toBeInTheDocument();
    // A fence by tap on a ring position: pick "next segment", tap ring 3.
    await user.click(within(screen.getByTestId("tray-fence-next")).getByRole("button"));
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-placing", "fence");
    await user.click(screen.getByText("tap-ring-3"));
    expect(screen.getByTestId("iso-canvas").getAttribute("data-fences")).toBe("1");
    expect(screen.getByTestId("budget-meter")).toHaveTextContent("1 of");
    expect(screen.getByTestId("gaps-line")).toHaveTextContent("27 open positions");
    // Take the post back.
    await user.click(screen.getByText("tap-u-rider"));
    await user.click(screen.getByTestId("selection-remove"));
    expect(screen.getByTestId("iso-canvas").getAttribute("data-posts")).toBe("0");
    expect(screen.getByTestId("tray-unit-u-rider")).toHaveTextContent("In the wagon");
  });

  it("B2: a post's circles are the resolver's reach, at true radii (aggro and attack include UNIT_RADIUS)", async () => {
    const user = userEvent.setup();
    render(screenWith(fakeApi()));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-12-12"));
    const [aggro, leash, attack] = (JSON.parse(screen.getByTestId("iso-canvas").getAttribute("data-radii")!) as [number, number, number][])[0]!;
    const { getUnitType, FIXED_POINT_SCALE } = await import("@caravan/content");
    const t = getUnitType("desert.dust_rider")!;
    expect(aggro).toBeCloseTo((t.aggroRadius + TUNABLES.UNIT_RADIUS) / FIXED_POINT_SCALE, 6);
    expect(leash).toBeCloseTo(t.leashDistance / FIXED_POINT_SCALE, 6);
    expect(attack).toBeCloseTo((t.attackRange + TUNABLES.UNIT_RADIUS) / FIXED_POINT_SCALE, 6);
  });

  it("S9: a refused tap says why, with circle's code, and changes nothing", async () => {
    const user = userEvent.setup();
    render(screenWith(fakeApi()));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-core"));
    const why = screen.getByTestId("drop-refused");
    expect(why).toHaveAttribute("data-code", "cell_reserved");
    expect(why).toHaveTextContent("Dust Rider was not placed: That cell is reserved");
    expect(why).toHaveTextContent("(cell_reserved)");
    expect(screen.getByTestId("iso-canvas").getAttribute("data-posts")).toBe("0");
  });

  it("D3: the DOM placement picker places a fence and a post without the canvas", async () => {
    const user = userEvent.setup();
    render(screenWith(fakeApi()));
    await user.click(within(screen.getByTestId("tray-fence-next")).getByRole("button"));
    const picker = within(screen.getByTestId("placement-picker"));
    const select = picker.getByTestId("picker-select") as HTMLSelectElement;
    expect(select.querySelectorAll("option:not([value=''])")).toHaveLength(28);
    expect(select.querySelectorAll("optgroup")).toHaveLength(4);
    const ring5 = ringSegment(5).cell;
    await user.selectOptions(select, `${ring5.x},${ring5.y}`);
    await user.click(picker.getByTestId("picker-place"));
    expect(screen.getByTestId("budget-meter")).toHaveTextContent("1 of");
    await user.click(within(screen.getByTestId("tray-fence-next")).getByRole("button"));
    // The taken position is listed but refused, with circle's code.
    const taken = within(screen.getByTestId("placement-picker")).getByRole("option", { name: new RegExp(`Ring position 5 \\(${ring5.x}, ${ring5.y}\\)`) });
    expect(taken).toBeDisabled();
    expect(taken.textContent).toMatch(/duplicate_segment/);
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.selectOptions(within(screen.getByTestId("placement-picker")).getByTestId("picker-select"), "12,13");
    await user.click(within(screen.getByTestId("placement-picker")).getByTestId("picker-place"));
    expect(screen.getByTestId("tray-unit-u-rider")).toHaveTextContent("Posted at (12, 13)");
  });

  it("S14: tapping an attacker marks its scouting card and opens the report", async () => {
    const user = userEvent.setup();
    render(screenWith(fakeApi()));
    await user.click(screen.getByText("tap-attacker"));
    const card = screen.getByTestId(`scout-unit-${scout.scout.units[0]!.ref}`);
    expect(card).toHaveAttribute("data-selected", "true");
    expect(document.activeElement).toBe(card);
  });

  it("B3: a cancelled canvas drag (a second finger) moves nothing", async () => {
    const user = userEvent.setup();
    render(screenWith(fakeApi()));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-12-12"));
    await user.click(screen.getByText("drag-begin-rider"));
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-drag", "yes");
    await user.click(screen.getByText("drag-cancel"));
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-drag", "no");
    expect(screen.getByTestId("tray-unit-u-rider")).toHaveTextContent("Posted at (12, 12)");
  });

  it("B4: a vertical touch swipe over the tray never drops; a long press then a move to the canvas does", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    try {
      render(screenWith(fakeApi()));
      const chip = within(screen.getByTestId("tray-unit-u-rider")).getByRole("button");
      // Swipe up from y=400 to y=50 (over the "canvas" in the mock): a scroll, not a drag.
      fireEvent.pointerDown(chip, { pointerId: 7, pointerType: "touch", clientX: 50, clientY: 400 });
      for (let y = 380; y >= 50; y -= 30) fireEvent.pointerMove(window, { pointerId: 7, pointerType: "touch", clientX: 50, clientY: y });
      fireEvent.pointerUp(window, { pointerId: 7, pointerType: "touch", clientX: 50, clientY: 50 });
      act(() => void vi.advanceTimersByTime(500));
      expect(screen.getByTestId("tray-unit-u-rider")).toHaveTextContent("In the wagon");
      // A pointercancel (the browser took it) never drops either.
      fireEvent.pointerDown(chip, { pointerId: 8, pointerType: "touch", clientX: 50, clientY: 400 });
      act(() => void vi.advanceTimersByTime(400));
      fireEvent.pointerCancel(window, { pointerId: 8, pointerType: "touch", clientX: 50, clientY: 50 });
      expect(screen.getByTestId("tray-unit-u-rider")).toHaveTextContent("In the wagon");
      // Long press, then move onto the canvas and lift: placed.
      fireEvent.pointerDown(chip, { pointerId: 9, pointerType: "touch", clientX: 50, clientY: 400 });
      act(() => void vi.advanceTimersByTime(400));
      expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-drag", "yes");
      fireEvent.pointerMove(window, { pointerId: 9, pointerType: "touch", clientX: 50, clientY: 60 });
      act(() => void vi.advanceTimersByTime(20));
      fireEvent.pointerUp(window, { pointerId: 9, pointerType: "touch", clientX: 50, clientY: 50 });
      expect(screen.getByTestId("tray-unit-u-rider")).toHaveTextContent("Posted at (12, 12)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the server's issue list with the player's names (S8), flags the chip, and never frames a gap as a problem", async () => {
    const user = userEvent.setup();
    const saveFormation = vi.fn(async () => {
      throw new ApiError(400, "invalid_formation", "the formation is not legal", undefined, [
        { code: "unit_not_posted", message: "living unit 'u-canteen' has no post", subject: "u-canteen" },
        { code: "unit_not_posted", message: "living unit 'u-rider' has no post", subject: "u-rider" },
      ]);
    });
    render(screenWith(fakeApi({ saveFormation })));
    await user.click(screen.getByTestId("save-draft"));
    const box = await screen.findByTestId("server-issues");
    expect(box).toHaveTextContent("The server refused this arrangement:");
    expect(box).toHaveTextContent("living unit Canteen Carrier has no post");
    expect(box).toHaveTextContent("living unit Dust Rider has no post");
    expect(box.textContent).not.toMatch(/u-canteen|u-rider/);
    expect(box).toHaveTextContent("unit_not_posted");
    expect(screen.getByTestId("tray-unit-u-canteen")).toHaveClass("chip--issue");
    await user.click(screen.getByTestId("issue-show-u-canteen"));
    expect(screen.getByTestId("tray-unit-u-canteen")).toHaveClass("chip--selected");
    expect(saveFormation).toHaveBeenCalledWith("c1", 3, expect.objectContaining({ v: 2 }));
    // Nothing on the screen calls a gap a warning, error or mistake.
    expect(document.body.textContent).not.toMatch(/gap[^.]*(warning|error|mistake|fix)/i);
    expect(document.body.textContent).not.toMatch(/(warning|error|mistake|fix)[^.]*gap/i);
  });

  it("S13: autosaves a moment after an edit; a refused autosave is a polite status, and the arrangement survives a remount", async () => {
    const user = userEvent.setup();
    const saveFormation = vi.fn(async () => {
      throw new ApiError(400, "invalid_formation", "the formation is not legal", undefined, [{ code: "unit_not_posted", message: "living unit 'u-canteen' has no post", subject: "u-canteen" }]);
    });
    const { unmount } = render(screenWith(fakeApi({ saveFormation }), { autosaveMs: 20 }));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-12-12"));
    const pending = await screen.findByTestId("autosave-pending");
    expect(pending).toHaveAttribute("role", "status");
    expect(pending).toHaveTextContent("living unit Canteen Carrier has no post");
    expect(screen.queryByTestId("server-issues")).toBeNull();
    expect(saveFormation).toHaveBeenCalledTimes(1);
    unmount();
    render(screenWith(fakeApi({ saveFormation }), { autosaveMs: NO_AUTOSAVE }));
    expect(screen.getByTestId("tray-unit-u-rider")).toHaveTextContent("Posted at (12, 12)");
  });

  it("S13: an accepted autosave is the server's draft", async () => {
    const user = userEvent.setup();
    const saveFormation = vi.fn(async (_c: string, _n: number, f: Formation) => formationView(f, null));
    render(screenWith(fakeApi({ saveFormation }), { autosaveMs: 20 }));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-12-12"));
    expect(await screen.findByText("Draft saved automatically.")).toBeInTheDocument();
  });

  it("N8: clearing the ground asks first", async () => {
    const user = userEvent.setup();
    render(screenWith(fakeApi()));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-12-12"));
    await user.click(screen.getByTestId("clear-open"));
    expect(screen.getByRole("dialog")).toHaveTextContent("Clear the ground?");
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.getByTestId("iso-canvas").getAttribute("data-posts")).toBe("1");
    await user.click(screen.getByTestId("clear-open"));
    await user.click(screen.getByTestId("clear-confirm"));
    expect(screen.getByTestId("iso-canvas").getAttribute("data-posts")).toBe("0");
  });

  it("S7: the commit dialog names what is unposted and held back, and keeps Commit disabled while the server refuses", async () => {
    const user = userEvent.setup();
    const saveFormation = vi.fn(async () => {
      throw new ApiError(400, "invalid_formation", "the formation is not legal", undefined, [{ code: "unit_not_posted", message: "living unit 'u-canteen' has no post", subject: "u-canteen" }]);
    });
    render(screenWith(fakeApi({ saveFormation })));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-12-12"));
    await user.click(screen.getByTestId("commit-open"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("commit-unposted")).toHaveTextContent("Not yet posted: Canteen Carrier");
    expect(within(dialog).getByTestId("commit-traps-held")).toHaveTextContent("Held back in the wagon: Jaw Trap");
    expect(dialog).toHaveTextContent(`${TUNABLES.FENCE_MATERIAL_BUDGET - 1} fence segments left in the wagon`);
    const refused = await within(dialog).findByTestId("commit-refused");
    expect(refused).toHaveTextContent("living unit Canteen Carrier has no post");
    expect(screen.getByTestId("commit-confirm")).toBeDisabled();
  });

  it("commits through a real modal that itemizes the arrangement: the server checks, then commit; focus lands on the outcome (S6)", async () => {
    const user = userEvent.setup();
    let stored: Formation = EMPTY_FORMATION;
    const saveFormation = vi.fn(async (_c: string, _n: number, f: Formation) => {
      stored = f;
      return formationView(f, null);
    });
    // Chunk 23: the commit goes through the trip route (frozen + queued), then the formation is re-read.
    const commitEncounter = vi.fn(async () => ({ jobId: "encounter:t:3", jobStatus: "queued", created: true }));
    const formation = vi.fn(async () => formationView(stored, "2026-10-11T12:00:00.000Z"));
    const onCommitted = vi.fn();
    render(screenWith(fakeApi({ saveFormation, commitEncounter, formation }), { onCommitted }));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-12-12"));
    await user.click(within(screen.getByTestId("tray-fence-next")).getByRole("button"));
    await user.click(screen.getByText("tap-ring-3"));

    const opener = screen.getByTestId("commit-open");
    opener.focus();
    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)).toHaveTextContent("1 fence segment on ring positions #3");
    expect(dialog).toHaveTextContent("27 ring positions left open");
    expect(dialog).toHaveTextContent("1 unit posted");
    expect(screen.getByTestId("commit-item-u-rider")).toHaveTextContent("Dust Rider · (12, 12) · Guard");
    // Healthiest-first then ref order: with every intact segment at full HP, "f10" sorts before "f2".
    expect(screen.getByTestId("commit-item-f10")).toHaveTextContent("Brush Pile · ring position 3, North");
    await waitFor(() => expect(screen.getByTestId("commit-confirm")).toBeEnabled());
    // The shell is inert while the dialog is open; focus is inside it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Escape closes and restores focus to the opener.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);

    await user.click(opener);
    await waitFor(() => expect(screen.getByTestId("commit-confirm")).toBeEnabled());
    await user.click(screen.getByTestId("commit-confirm"));
    const notice = await screen.findByTestId("committed-notice");
    expect(saveFormation).toHaveBeenCalledTimes(1);
    expect(commitEncounter).toHaveBeenCalledWith("c1", 3);
    expect(formation).toHaveBeenCalledWith("c1", 3);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(serializeFormation(stored)).toContain('"segment":3');
    expect(screen.getByTestId("formation-screen").getAttribute("data-committed")).toBe("true");
    expect(screen.queryByTestId("commit-open")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(notice));
    // S15: a locale time, never the raw ISO string, and no developer copy.
    expect(notice.textContent).not.toContain("2026-10-11T12:00:00.000Z");
    expect(notice.textContent).not.toMatch(/chunk \d+/i);
  });

  it("chunk 24 QA S5: a fight that resolved before the re-read (a fast overrun closes the manifest, 404) still moves the Trail on", async () => {
    const user = userEvent.setup();
    const saveFormation = vi.fn(async (_c: string, _n: number, f: Formation) => formationView(f, null));
    const commitEncounter = vi.fn(async () => ({ jobId: "encounter:t:3", jobStatus: "queued", created: true }));
    const formation = vi.fn(async () => {
      throw new ApiError(404, "no_open_manifest", "this caravan is in town with nothing packed");
    });
    const onCommitted = vi.fn();
    render(screenWith(fakeApi({ saveFormation, commitEncounter, formation }), { onCommitted }));
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-12-12"));
    await user.click(screen.getByTestId("commit-open"));
    await waitFor(() => expect(screen.getByTestId("commit-confirm")).toBeEnabled());
    await user.click(screen.getByTestId("commit-confirm"));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    expect(commitEncounter).toHaveBeenCalledWith("c1", 3);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a malformed server payload as bad_payload with its path, not a crash", async () => {
    // The API client's guard (src/api/shapes.ts, pinned in client.test.ts) raises this before
    // a screen sees the body; the screen's job is to show it with the offending path.
    const user = userEvent.setup();
    const where = "PUT /caravans/c1/encounters/3/formation formation.formation: expected formation body (formation.posts[0].stance must be one of guard, hold, reserve), got object";
    const saveFormation = vi.fn(async () => {
      throw new ApiError(0, BAD_PAYLOAD, where, where);
    });
    render(screenWith(fakeApi({ saveFormation })));
    await user.click(screen.getByTestId("save-draft"));
    const box = await screen.findByTestId("api-error");
    expect(box).toHaveTextContent("bad_payload");
    expect(box).toHaveTextContent("formation.posts[0].stance");
  });
});
