import { EMPTY_FORMATION, ringSegment, serializeFormation, formationGaps, type Formation } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { survivorsManifest } from "../../test/circleFixtures.ts";
import { FormationScreen } from "./FormationScreen.tsx";
import { fixturePartyFor } from "./scoutFixture.ts";

// The canvas needs WebGL; in jsdom it is replaced by buttons that fire the same callbacks
// the real one fires from taps. Placement logic is in placement.ts and tested there.
vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => (props.state.drag ? 0.38 : 0) }));
    return (
      <div data-testid="iso-canvas" data-drag={props.state.drag ? "yes" : "no"} data-posts={props.state.posts.length} data-fences={props.state.fences.length} data-attackers={props.state.attackers.length}>
        <button type="button" onClick={() => props.onTapCell?.({ x: 12, y: 12 })}>
          tap-12-12
        </button>
        <button type="button" onClick={() => props.onTapCell?.(ringSegment(3).cell)}>
          tap-ring-3
        </button>
        <button type="button" onClick={() => props.onTapEntity?.({ kind: "post", id: "u-rider" })}>
          tap-u-rider
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
    ...over,
  };
}

function trip() {
  const survivors = survivorsManifest();
  return {
    survivors,
    packed: survivors,
    view: { id: "m1", caravanId: "c1", encountersResolved: 2, createdAt: "", closedAt: null, packed: survivors, survivors, summary: { unitsAlive: 2, unitsDead: 1, trapsUnspent: 1, trapsSpent: 1, fencesIntact: 19, fencesDestroyed: 1 }, formations: [] },
  };
}

function formationView(f: Formation, committedAt: string | null) {
  return { formation: { manifestId: "m1", encounterIndex: 3, formation: f, hash: "h", gaps: [...formationGaps(f)], committedAt } };
}

const scout = { encounterIndex: 3, party: fixturePartyFor(3), source: "fixture" as const, ownerLabel: null };

describe("FormationScreen", () => {
  it("shows what survives truthfully: a dead unit, a spent trap, a chipped and a destroyed segment, and the attackers", () => {
    render(<FormationScreen api={fakeApi()} caravanId="c1" trip={trip()} encounterIndex={3} initial={null} scout={scout} />);
    expect(screen.getByRole("heading", { name: "Encounter 3" })).toBeInTheDocument();
    const tray = within(screen.getByTestId("manifest-tray"));
    expect(tray.getByTestId("tray-unit-u-digger")).toHaveTextContent("Dead — lost earlier this trip");
    expect(tray.getByTestId("tray-unit-u-rider")).toHaveTextContent(/206 \/ 620 HP/);
    expect(tray.getByTestId("tray-trap-t0")).toHaveTextContent("Spent — traps fire once and do not re-arm this trip");
    expect(tray.getByTestId("tray-trap-t1")).toHaveTextContent("Fires once; does not re-arm this trip.");
    expect(tray.getByTestId("fence-tray-line")).toHaveTextContent(`${TUNABLES.FENCE_MATERIAL_BUDGET - 1} in the wagon · 0 on the ring · 1 destroyed · ${TUNABLES.FENCE_MATERIAL_BUDGET} packed`);
    expect(tray.getByTestId("tray-fence-f1")).toHaveTextContent("120 / 300 HP");
    expect(tray.getByTestId("tray-fence-f0")).toHaveTextContent("Destroyed earlier this trip");
    expect(screen.getByTestId("iso-canvas").getAttribute("data-attackers")).toBe(String(scout.party.units.length));
    // Both ratings for a defender, defense emphasized.
    const pair = tray.getAllByRole("group", { name: /Offense 95, Defense 55/ })[0]!;
    expect(pair.querySelector(".statpair__stat--big .statpair__lbl")?.textContent).toBe("Defense");
    // The scouting panel is on the screen before anything is committed.
    expect(screen.getByTestId("scout-panel")).toBeInTheDocument();
    expect(screen.getByTestId("budget-meter")).toHaveTextContent(`0 of ${TUNABLES.FENCE_MATERIAL_BUDGET - 1} segments placed · 28 ring positions`);
    expect(screen.getByTestId("gaps-line")).toHaveTextContent("28 open positions");
  });

  it("places by tap: select a unit, tap a cell; stance picker appears; stance changes; take back", async () => {
    const user = userEvent.setup();
    render(<FormationScreen api={fakeApi()} caravanId="c1" trip={trip()} encounterIndex={3} initial={null} scout={scout} />);
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    expect(screen.getByTestId("tap-to-place-hint")).toBeInTheDocument();
    await user.click(screen.getByText("tap-12-12"));
    expect(screen.getByTestId("iso-canvas").getAttribute("data-posts")).toBe("1");
    expect(screen.getByTestId("tray-unit-u-rider")).toHaveTextContent("Posted at (12, 12)");
    const picker = within(screen.getByTestId("stance-picker"));
    expect(picker.getByRole("radio", { name: "Guard" })).toHaveAttribute("aria-checked", "true");
    await user.click(picker.getByRole("radio", { name: "Hold" }));
    expect(picker.getByRole("radio", { name: "Hold" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Fights only what comes within attack range of the post. Never leaves it.")).toBeInTheDocument();
    // A fence by tap on a ring position: pick "next segment", tap ring 3.
    await user.click(within(screen.getByTestId("tray-fence-next")).getByRole("button"));
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

  it("surfaces the server's issue list exactly on save, and never frames a gap as a problem", async () => {
    const user = userEvent.setup();
    const saveFormation = vi.fn(async () => {
      throw new ApiError(400, "invalid_formation", "the formation is not legal", [
        { code: "unit_not_posted", message: "living unit 'u-canteen' has no post", subject: "u-canteen" },
        { code: "unit_not_posted", message: "living unit 'u-rider' has no post", subject: "u-rider" },
      ]);
    });
    render(<FormationScreen api={fakeApi({ saveFormation })} caravanId="c1" trip={trip()} encounterIndex={3} initial={null} scout={scout} />);
    await user.click(screen.getByTestId("save-draft"));
    const box = await screen.findByTestId("server-issues");
    expect(box).toHaveTextContent("The server refused this arrangement:");
    expect(box).toHaveTextContent("living unit 'u-canteen' has no post");
    expect(box).toHaveTextContent("living unit 'u-rider' has no post");
    expect(box).toHaveTextContent("unit_not_posted");
    expect(saveFormation).toHaveBeenCalledWith("c1", 3, expect.objectContaining({ v: 2 }));
    // Nothing on the screen calls a gap a warning, error or mistake.
    expect(document.body.textContent).not.toMatch(/gap[^.]*(warning|error|mistake|fix)/i);
    expect(document.body.textContent).not.toMatch(/(warning|error|mistake|fix)[^.]*gap/i);
  });

  it("commits through a real modal that itemizes the arrangement: save (if dirty) then commit, then locks", async () => {
    const user = userEvent.setup();
    let stored: Formation = EMPTY_FORMATION;
    const saveFormation = vi.fn(async (_c: string, _n: number, f: Formation) => {
      stored = f;
      return formationView(f, null);
    });
    const commitFormation = vi.fn(async () => formationView(stored, "2026-10-11T12:00:00.000Z"));
    render(<FormationScreen api={fakeApi({ saveFormation, commitFormation })} caravanId="c1" trip={trip()} encounterIndex={3} initial={null} scout={scout} />);
    await user.click(within(screen.getByTestId("tray-unit-u-rider")).getByRole("button"));
    await user.click(screen.getByText("tap-12-12"));
    await user.click(within(screen.getByTestId("tray-fence-next")).getByRole("button"));
    await user.click(screen.getByText("tap-ring-3"));

    const opener = screen.getByTestId("commit-open");
    opener.focus();
    await user.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)).toHaveTextContent("1 fence segment on ring positions #3");
    expect(dialog).toHaveTextContent("27 ring positions left open");
    expect(dialog).toHaveTextContent("1 unit posted");
    expect(screen.getByTestId("commit-item-u-rider")).toHaveTextContent("Dust Rider · (12, 12) · guard");
    // Healthiest-first then ref order: with every intact segment at full HP, "f10" sorts before "f2".
    expect(screen.getByTestId("commit-item-f10")).toHaveTextContent("Brush Pile · #3 north");
    // The shell is inert while the dialog is open; focus is inside it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Escape closes and restores focus to the opener.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);

    await user.click(opener);
    await user.click(screen.getByTestId("commit-confirm"));
    await screen.findByTestId("committed-notice");
    expect(saveFormation).toHaveBeenCalledTimes(1);
    expect(commitFormation).toHaveBeenCalledWith("c1", 3);
    expect(serializeFormation(stored)).toContain('"segment":3');
    expect(screen.getByTestId("formation-screen").getAttribute("data-committed")).toBe("true");
    expect(screen.queryByTestId("commit-open")).toBeNull();
  });

  it("turns a malformed server payload into bad_payload, not a crash", async () => {
    const user = userEvent.setup();
    const saveFormation = vi.fn(async () => ({ formation: { nonsense: true } }) as never);
    render(<FormationScreen api={fakeApi({ saveFormation })} caravanId="c1" trip={trip()} encounterIndex={3} initial={null} scout={scout} />);
    await user.click(screen.getByTestId("save-draft"));
    const box = await screen.findByTestId("error-box");
    expect(box).toHaveTextContent("bad_payload");
  });
});
