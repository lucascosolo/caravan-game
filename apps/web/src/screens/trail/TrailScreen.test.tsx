import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { CandidateMenuView } from "../../api/types.ts";
import { SessionProvider } from "../../auth/session.tsx";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { survivorsManifest } from "../../test/circleFixtures.ts";
import { fixtureCandidate } from "./scoutFixture.ts";
import { TrailScreen } from "./TrailScreen.tsx";

vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => 0 }));
    return <div data-testid="iso-canvas" data-attackers={props.state.attackers.length} />;
  });
  return { ...actual, IsoCanvas };
});

// The session's api is built from fetch; route by method + path like the chunk 06 fixtures do.
type Handler = (body: unknown) => { status: number; body: unknown };
function fetchFor(routes: Record<string, Handler>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? "GET"} ${url.replace(/^\/api/, "")}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: "not_found", message: `no route ${key}` }), { status: 404 });
    const r = h(init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const CARAVAN = "22222222-2222-4222-8222-222222222222";
const survivors = survivorsManifest();
const manifestBody = {
  manifest: {
    id: "m1",
    caravanId: CARAVAN,
    encountersResolved: 0,
    createdAt: "",
    closedAt: null,
    packed: survivors,
    survivors,
    summary: { unitsAlive: 2, unitsDead: 1, trapsUnspent: 1, trapsSpent: 1, fencesIntact: 19, fencesDestroyed: 1 },
    formations: [],
  },
};

function menuOf(chosen: string | null, availableAtMs: number): CandidateMenuView {
  const candidates = [fixtureCandidate(1, "a".repeat(32)), fixtureCandidate(2, "b".repeat(32)), fixtureCandidate(3, "c".repeat(32))];
  return {
    tripId: "t1",
    encounterIndex: 1,
    searchSeq: 1,
    caravan: { rating: 1000, ratingPool: "living", band: { index: 1, low: 1000, high: 1099 } },
    centre: 1000,
    escalation: { applied: 0, perEncounter: 25, nextEncounter: 25 },
    bandWidthUsed: 100,
    widened: false,
    authoredOutsideBand: true,
    authoredShare: { authored: 3, of: 3, shareBp: 10_000, maxShareBp: 3_000 },
    authoredServed: null,
    candidates,
    searchedAtMs: Date.now(),
    reroll: { gate: "time", cooldownSeconds: 60, availableAtMs, available: availableAtMs <= Date.now() },
    chosen: chosen ? { candidateId: chosen, chosenAt: "2026-10-11T00:00:00.000Z" } : null,
  };
}

function mount(fetchImpl: typeof fetch) {
  // The screen needs a signed-in session; sign in through the provider's own login route.
  return render(
    <SessionProvider fetchImpl={fetchImpl}>
      <Signed />
    </SessionProvider>,
  );
}
import { useEffect } from "react";
import { useSession } from "../../auth/session.tsx";
function Signed(): JSX.Element {
  const { session, signIn } = useSession();
  useEffect(() => {
    if (!session) signIn({ token: "tok", expiresAt: "", account: { id: "acc", username: "dev" } });
  }, [session, signIn]);
  return session ? <TrailScreen /> : <p>…</p>;
}

describe("TrailScreen — search, scout three candidates, reroll gate, choose, arrange", () => {
  it("shows the search button when nothing was searched, then three fully scoutable candidates with a visible free reroll timer, then the formation after choosing", async () => {
    const user = userEvent.setup();
    let menu: CandidateMenuView | null = null;
    const chooseCalls: unknown[] = [];
    const fetchImpl = fetchFor({
      "GET /me": () => ({ status: 200, body: { account: { id: "acc", username: "dev" }, caravans: [{ id: CARAVAN, name: "x", region_id: "desert", units: [] }] } }),
      [`GET /caravans/${CARAVAN}/manifest`]: () => ({ status: 200, body: manifestBody }),
      [`GET /me/caravans/${CARAVAN}/encounters/1/candidates`]: () => (menu ? { status: 200, body: { menu } } : { status: 404, body: { error: "no_search", message: "no candidates have been searched for encounter 1" } }),
      [`POST /me/caravans/${CARAVAN}/encounters/1/search`]: () => {
        menu = menuOf(null, Date.now() + 60_000);
        return { status: 201, body: { menu } };
      },
      [`POST /me/caravans/${CARAVAN}/encounters/1/choose`]: (body) => {
        chooseCalls.push(body);
        const id = (body as { candidateId: string }).candidateId;
        menu = menuOf(id, menu!.reroll.availableAtMs);
        return { status: 200, body: { menu, chosen: menu.candidates.find((c) => c.candidateId === id) } };
      },
      [`GET /caravans/${CARAVAN}/encounters/1/formation`]: () => ({ status: 404, body: { error: "no_formation", message: "no formation for encounter 1" } }),
    });
    mount(fetchImpl);
    await user.click(await screen.findByTestId("search"));

    const list = await screen.findByTestId("candidate-list");
    expect(within(list).getAllByRole("listitem", { name: "" }).length).toBeGreaterThanOrEqual(3);
    for (const i of [0, 1, 2]) {
      const card = within(screen.getByTestId(`candidate-${i}`));
      expect(card.getByText(`Fixture outfit ${i + 1}`)).toBeInTheDocument();
      expect(card.getByText(/Reputation \(band 1000–1099\)/)).toBeInTheDocument();
      expect(card.getByTestId(`scout-panel-${i}`)).toBeInTheDocument();
      expect(card.getAllByText(/Enters from the/).length).toBeGreaterThan(0);
    }
    // B1: the server's authored facts, said as reported.
    expect(screen.getByTestId("authored-outside-band")).toHaveTextContent("Includes authored parties from outside your band");
    expect(screen.getByTestId("authored-share")).toHaveTextContent("3 of 3 offered are authored parties (the draw keeps authored parties to 30%");
    // N1: each candidate's scouting report is open, and above its "Face …" button.
    for (const i of [0, 1, 2]) {
      const details = screen.getByTestId(`candidate-${i}`).querySelector("details")!;
      expect(details.open).toBe(true);
      expect(details.compareDocumentPosition(screen.getByTestId(`choose-${i}`)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The reroll is visible, free, and time-gated: disabled with the seconds shown. No Coin anywhere.
    const reroll = screen.getByTestId("reroll");
    expect(reroll).toBeDisabled();
    expect(reroll).toHaveTextContent(/Search again in \d+s \(free, time-gated\)/);
    // No Coin reroll, purchase or shortcut anywhere; the earn multiplier line is a server fact and stays.
    expect(document.body.textContent).not.toMatch(/(buy|purchase|pay|coin(?! earn))/i);
    expect(reroll.textContent).not.toMatch(/coin/i);

    await user.click(screen.getByTestId("choose-1"));
    expect(chooseCalls).toEqual([{ candidateId: "b".repeat(32) }]);
    await screen.findByTestId("formation-screen");
    expect(screen.getByTestId("facing-line")).toHaveTextContent("Facing Fixture outfit 2.");
    expect(screen.getByTestId("iso-canvas").getAttribute("data-attackers")).toBe("5");
  });

  it("surfaces a refused reroll exactly (409 reroll_cooldown with availableAtMs) and the no-trip state", async () => {
    const user = userEvent.setup();
    const menu = menuOf(null, Date.now() - 1000);
    const fetchImpl = fetchFor({
      "GET /me": () => ({ status: 200, body: { account: { id: "acc", username: "dev" }, caravans: [{ id: CARAVAN, name: "x", region_id: "desert", units: [] }] } }),
      [`GET /caravans/${CARAVAN}/manifest`]: () => ({ status: 200, body: manifestBody }),
      [`GET /me/caravans/${CARAVAN}/encounters/1/candidates`]: () => ({ status: 200, body: { menu } }),
      [`POST /me/caravans/${CARAVAN}/encounters/1/search`]: () => ({
        status: 409,
        body: { error: "reroll_cooldown", message: "the next free search opens in 42 s", availableAtMs: Date.now() + 42_000, retryAfterSeconds: 42, gate: "time" },
      }),
    });
    mount(fetchImpl);
    const reroll = await screen.findByTestId("reroll");
    expect(reroll).toBeEnabled();
    await user.click(reroll);
    const refused = await screen.findByTestId("reroll-refused");
    expect(refused).toHaveTextContent("the next free search opens in 42 s");
    expect(refused).toHaveTextContent("reroll_cooldown");
    expect(refused).toHaveTextContent(/The next free search opens in 4[12]s\./);
  });

  it("packed but no open trip is a state, not an error", async () => {
    const fetchImpl = fetchFor({
      "GET /me": () => ({ status: 200, body: { account: { id: "acc", username: "dev" }, caravans: [{ id: CARAVAN, name: "x", region_id: "desert", units: [] }] } }),
      [`GET /caravans/${CARAVAN}/manifest`]: () => ({ status: 200, body: manifestBody }),
      [`GET /me/caravans/${CARAVAN}/encounters/1/candidates`]: () => ({ status: 404, body: { error: "no_trip", message: "this caravan is in town; nothing to search for" } }),
    });
    mount(fetchImpl);
    expect(await screen.findByTestId("trail-no-trip")).toHaveTextContent("Packed, but not yet on the trail.");
    expect(screen.queryByTestId("api-error")).toBeNull();
  });

  it("a malformed menu is bad_payload with Retry, not a crash", async () => {
    const fetchImpl = fetchFor({
      "GET /me": () => ({ status: 200, body: { account: { id: "acc", username: "dev" }, caravans: [{ id: CARAVAN, name: "x", region_id: "desert", units: [] }] } }),
      [`GET /caravans/${CARAVAN}/manifest`]: () => ({ status: 200, body: manifestBody }),
      [`GET /me/caravans/${CARAVAN}/encounters/1/candidates`]: () => ({ status: 200, body: { menu: { tripId: "t1", candidates: "nope" } } }),
    });
    mount(fetchImpl);
    expect(await screen.findByTestId("api-error")).toHaveTextContent("bad_payload");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(new ApiError(0, "x", "y").issues).toEqual([]);
  });

  it("S4: the reroll countdown ignores the device clock — a clock 10 minutes fast cannot open it early", async () => {
    const realNow = Date.now;
    const serverNow = realNow();
    // The device clock is 10 minutes ahead of the server's.
    Date.now = () => realNow() + 10 * 60_000;
    try {
      const menu = { ...menuOf(null, serverNow + 60_000), searchedAtMs: serverNow, reroll: { gate: "time" as const, cooldownSeconds: 60, availableAtMs: serverNow + 60_000, available: false } };
      const fetchImpl = fetchFor({
        "GET /me": () => ({ status: 200, body: { account: { id: "acc", username: "dev" }, caravans: [{ id: CARAVAN, name: "x", region_id: "desert", units: [] }] } }),
        [`GET /caravans/${CARAVAN}/manifest`]: () => ({ status: 200, body: manifestBody }),
        [`GET /me/caravans/${CARAVAN}/encounters/1/candidates`]: () => ({ status: 200, body: { menu } }),
      });
      mount(fetchImpl);
      const reroll = await screen.findByTestId("reroll");
      expect(reroll).toBeDisabled();
      expect(Number(reroll.getAttribute("data-seconds-left"))).toBeGreaterThanOrEqual(59);
    } finally {
      Date.now = realNow;
    }
  });

  it("B1/N4: the menu guard takes the server's real shape and refuses a chosen id the menu does not carry", async () => {
    const { menuShape } = await import("../../api/shapes.ts");
    const { expectShape } = await import("../../api/shape.ts");
    const ok = menuOf(null, Date.now());
    expect(() => expectShape(menuShape, { menu: ok })).not.toThrow();
    // The client view carries no owner account id, and an extra one (older server) is ignored.
    expect(() => expectShape(menuShape, { menu: { ...ok, candidates: ok.candidates.map((c) => ({ ...c, owner: { ...c.owner, accountId: "x" } })) } })).not.toThrow();
    expect(() => expectShape(menuShape, { menu: { ...ok, chosen: { candidateId: "f".repeat(32), chosenAt: "2026-10-11T00:00:00.000Z" } } })).toThrow(/chosen\.candidateId/);
    const bad = (mut: (u: Record<string, unknown>) => Record<string, unknown>) => ({ menu: { ...ok, candidates: ok.candidates.map((c, i) => (i ? c : { ...c, scout: { ...c.scout, units: c.scout.units.map((u, j) => (j ? u : mut({ ...u }))) } })) } });
    expect(() => expectShape(menuShape, bad((u) => ({ ...u, cell: { x: 32, y: 0 } })))).toThrow(/cell\.x/);
    expect(() => expectShape(menuShape, bad((u) => ({ ...u, typeId: "desert.nope" })))).toThrow(/known unit type id/);
    // A menu stored before S1 has no damagePerHitMult: the guard fills content's multiplier for that level.
    const parsed = expectShape(menuShape, bad((u) => { const { damagePerHitMult: _drop, ...rest } = u; return rest; }));
    expect(parsed.menu.candidates[0]!.scout.units[0]!.damagePerHitMult).toBe(ok.candidates[0]!.scout.units[0]!.damagePerHitMult);
  });
});
