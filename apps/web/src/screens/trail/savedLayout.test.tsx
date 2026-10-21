// Chunk 51: saved layouts on the formation screen. Hints inform, never block or edit;
// the left-out note never fades; the old "Start from my last arrangement" button is gone.
import { CORE_CENTER_CELL, layoutHints, type Formation } from "@caravan/circle";
import { getFenceTier, getTrapType, getUnitType } from "@caravan/content";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../api/client.ts";
import type { LayoutView, ManifestView } from "../../api/types.ts";
import { SessionProvider, useSession } from "../../auth/session.tsx";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { survivorsManifest } from "../../test/circleFixtures.ts";
import { statusArranging } from "../../test/tripFixtures.ts";
import { FormationScreen, clearLocalDrafts } from "./FormationScreen.tsx";
import { fixtureCandidate, fixtureEncounter } from "./scoutFixture.ts";
import { TrailScreen } from "./TrailScreen.tsx";

vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => 0, zoom: () => 1, pixiAccessibility: () => false }));
    return <div data-testid="iso-canvas" data-posts={props.state.posts.length} data-fences={props.state.fences.length} />;
  });
  return { ...actual, IsoCanvas };
});

const notCalled = () => Promise.reject(new Error("not expected"));
function fakeApi(over: Partial<Api> = {}): Api {
  const base = { formationIfAny: async () => null, candidates: async () => ({ menu: null, searched: false }), ...over };
  return new Proxy(base, { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : notCalled) }) as unknown as Api;
}

function trip(): ManifestView {
  const survivors = survivorsManifest();
  return { id: "m1", caravanId: "c1", encountersResolved: 1, createdAt: "", closedAt: null, packed: survivors, survivors, summary: { unitsAlive: 2, unitsDead: 1, trapsUnspent: 1, trapsSpent: 1, fencesIntact: 19, fencesDestroyed: 1 }, formations: [] };
}

// Raiders from the north only.
const base = fixtureEncounter(2);
const scout = { ...base, scout: { ...base.scout, units: base.scout.units.map((u) => ({ ...u, edge: "north" as const })) } };

// A trap on the west side (no raider there), a post, and a layout saved against north + east.
const loaded: Formation = {
  v: 3,
  fences: [],
  traps: [{ ref: "t1", cell: { x: CORE_CENTER_CELL.x - 5, y: CORE_CENTER_CELL.y } }],
  posts: [{ ref: "u-rider", cell: { x: 12, y: 12 }, stance: "guard" }],
};
const leftOut: LayoutView["leftOut"] = [
  { kind: "fence", typeId: "fence.brush_pile", instanceId: null, edge: "north", reason: "wagon" },
  { kind: "post", typeId: "desert.well_digger", instanceId: "u-digger", edge: "east", reason: "dead" },
  { kind: "trap", typeId: "trap.spike_pit", instanceId: null, edge: "south", reason: "spent" },
];
function layoutOf(over: Partial<LayoutView> = {}): LayoutView {
  return { loaded, leftOut, savedSides: ["north", "east"], hintsOn: true, unavailable: null, ...over };
}
const expectedKeys = () =>
  layoutHints(loaded, scout.scout, ["north", "east"]).map((h) => (h.code === "trap_unused_side" ? `trap_unused_side:${h.ref}` : h.code));

function screenWith(api: Api, extra: { layout?: LayoutView | null; initial?: unknown; encounterIndex?: number } = {}) {
  return (
    <FormationScreen
      api={api}
      caravanId="c1"
      trip={trip()}
      encounterIndex={extra.encounterIndex ?? 2}
      initial={(extra.initial ?? null) as never}
      scout={scout}
      autosaveMs={3_600_000}
      {...(extra.layout !== undefined ? { layout: extra.layout } : {})}
    />
  );
}

beforeEach(() => clearLocalDrafts());

describe("saved layouts on the formation screen", () => {
  it("starts from the loaded layout when there is no draft", () => {
    render(screenWith(fakeApi(), { layout: layoutOf() }));
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-posts", "1");
  });

  it("a stored draft beats the loaded layout", () => {
    const draft = { manifestId: "m1", encounterIndex: 2, formation: { v: 3, fences: [], traps: [], posts: [] }, hash: "h", gaps: [], committedAt: null };
    render(screenWith(fakeApi(), { layout: layoutOf(), initial: draft }));
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-posts", "0");
  });

  it("lists every left-out piece in order, by display name, with the wagon wording", () => {
    render(screenWith(fakeApi(), { layout: layoutOf() }));
    const note = screen.getByTestId("layout-left-out");
    const items = within(note).getAllByTestId("layout-left-out-item");
    expect(items.map((i) => i.getAttribute("data-reason"))).toEqual(["wagon", "dead", "spent"]);
    expect(items[0]).toHaveTextContent(getFenceTier("fence.brush_pile")!.displayName);
    expect(items[0]).toHaveTextContent("already walled by a wagon here");
    expect(items[1]).toHaveTextContent(getUnitType("desert.well_digger")!.displayName);
    expect(items[2]).toHaveTextContent(getTrapType("trap.spike_pit")!.displayName);
  });

  it("the left-out note shows with hints off, and then there are no hints", () => {
    render(screenWith(fakeApi(), { layout: layoutOf({ hintsOn: false }) }));
    expect(screen.getByTestId("layout-left-out")).toBeInTheDocument();
    expect(screen.queryAllByTestId("layout-hint")).toHaveLength(0);
  });

  it("an unavailable layout says so and the formation starts empty", () => {
    render(screenWith(fakeApi(), { layout: layoutOf({ unavailable: "battlefield_version", leftOut: [] }) }));
    expect(screen.getByTestId("layout-unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-posts", "0");
  });

  it("shows layoutHints with keys; dismissing one hides only it, saves nothing, changes nothing", async () => {
    const user = userEvent.setup();
    const saveFormation = vi.fn(async () => {
      throw new Error("dismissing a hint must not save");
    });
    render(screenWith(fakeApi({ saveFormation }), { layout: layoutOf() }));
    const keys = () => screen.queryAllByTestId("layout-hint").map((h) => h.getAttribute("data-hint"));
    expect(keys()).toEqual(expectedKeys());
    expect(expectedKeys()).toContain("trap_unused_side:t1");
    expect(expectedKeys()).toContain("direction_changed");
    const meter = screen.getByTestId("budget-meter").textContent;
    const hint = screen.getAllByTestId("layout-hint").find((h) => h.getAttribute("data-hint") === "direction_changed")!;
    await user.click(within(hint).getByTestId("layout-hint-dismiss"));
    expect(keys()).toEqual(expectedKeys().filter((k) => k !== "direction_changed"));
    expect(screen.getByTestId("budget-meter").textContent).toBe(meter);
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-posts", "1");
    expect(saveFormation).not.toHaveBeenCalled();
  });

  it("hint wording is information, never a verdict", () => {
    render(screenWith(fakeApi(), { layout: layoutOf() }));
    const hints = screen.getAllByTestId("layout-hint");
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) expect(h.textContent).not.toMatch(/should|mistake/i);
  });

  it("hints never change whether Commit is available", () => {
    const on = render(screenWith(fakeApi(), { layout: layoutOf() }));
    expect(screen.getAllByTestId("layout-hint").length).toBeGreaterThan(0);
    const withHints = (screen.getByTestId("commit-open") as HTMLButtonElement).disabled;
    on.unmount();
    render(screenWith(fakeApi(), { layout: layoutOf({ hintsOn: false }) }));
    expect(screen.queryAllByTestId("layout-hint")).toHaveLength(0);
    expect((screen.getByTestId("commit-open") as HTMLButtonElement).disabled).toBe(withHints);
  });

  it("a committed encounter shows neither the note nor hints", () => {
    const committed = { manifestId: "m1", encounterIndex: 2, formation: loaded, hash: "h", gaps: [], committedAt: "2026-10-11T12:00:00.000Z" };
    render(screenWith(fakeApi(), { layout: layoutOf(), initial: committed }));
    expect(screen.queryByTestId("layout-left-out")).toBeNull();
    expect(screen.queryAllByTestId("layout-hint")).toHaveLength(0);
  });

  it("'Start from my last arrangement' is gone at encounter 2", async () => {
    const candidates = vi.fn(async () => ({ menu: { candidates: [fixtureCandidate(1)], chosen: { candidateId: fixtureCandidate(1).candidateId, chosenAt: "" } } as never }));
    render(screenWith(fakeApi({ candidates }), { layout: null }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(screen.queryByTestId("start-from-last")).toBeNull();
  });
});

// ── TrailScreen passes the layout from api.formationRead ─────────────────────────────

const CARAVAN = "22222222-2222-4222-8222-222222222222";
function fetchFor(routes: Record<string, () => unknown>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = routes[`${init?.method ?? "GET"} ${url.replace(/^\/api/, "")}`];
    if (!h) return new Response(JSON.stringify({ error: "not_found", message: "no route" }), { status: 404 });
    return new Response(JSON.stringify(h()), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
function Signed(): JSX.Element {
  const { session, signIn } = useSession();
  useEffect(() => {
    if (!session) signIn({ token: "tok", expiresAt: "", account: { id: "acc", username: "dev" } });
  }, [session, signIn]);
  return session ? <TrailScreen /> : <p>…</p>;
}

describe("TrailScreen with a saved layout", () => {
  it("reads the formation with its layout and shows the left-out note", async () => {
    const cand = fixtureCandidate(1, "a".repeat(32));
    const survivors = survivorsManifest();
    const menu = {
      tripId: "t1", encounterIndex: 1, searchSeq: 1,
      caravan: { rating: 1000, ratingPool: "living", band: { index: 1, low: 1000, high: 1099 } },
      centre: 1000, escalation: { applied: 0, perEncounter: 25, nextEncounter: 25 }, bandWidthUsed: 100, widened: false, authoredOutsideBand: true,
      authoredShare: { authored: 1, of: 1, shareBp: 10_000, maxShareBp: 3_000 }, authoredServed: null, candidates: [cand], searchedAtMs: Date.now(),
      reroll: { gate: "time", cooldownSeconds: 60, availableAtMs: Date.now() - 1000, available: true },
      chosen: { candidateId: cand.candidateId, chosenAt: "2026-10-11T00:00:00.000Z" },
    };
    const fetchImpl = fetchFor({
      "GET /me": () => ({ account: { id: "acc", username: "dev" }, caravans: [{ id: CARAVAN, name: "x", region_id: "desert", units: [] }] }),
      [`GET /me/caravans/${CARAVAN}/trip`]: () => statusArranging(1),
      [`GET /caravans/${CARAVAN}/manifest`]: () => ({ manifest: { id: "m1", caravanId: CARAVAN, encountersResolved: 0, createdAt: "", closedAt: null, packed: survivors, survivors, summary: { unitsAlive: 2, unitsDead: 1, trapsUnspent: 1, trapsSpent: 1, fencesIntact: 19, fencesDestroyed: 1 }, formations: [] } }),
      [`GET /me/caravans/${CARAVAN}/encounters/1/candidates`]: () => ({ menu }),
      [`GET /caravans/${CARAVAN}/encounters/1/formation?ifNone=null`]: () => ({ formation: null, encounterIndex: 1, layout: layoutOf({ loaded: { v: 3, fences: [], traps: [], posts: [] } }) }),
    });
    render(
      <SessionProvider fetchImpl={fetchImpl}>
        <Signed />
      </SessionProvider>,
    );
    const note = await screen.findByTestId("layout-left-out");
    await waitFor(() => expect(within(note).getAllByTestId("layout-left-out-item")).toHaveLength(3));
  });
});
