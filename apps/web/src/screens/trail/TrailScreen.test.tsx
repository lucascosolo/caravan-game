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
    usedAuthoredFallback: true,
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
    expect(screen.getByText("Includes authored parties: too few players were in range.")).toBeInTheDocument();
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
    expect(screen.queryByTestId("error-box")).toBeNull();
  });

  it("a malformed menu is bad_payload with Retry, not a crash", async () => {
    const fetchImpl = fetchFor({
      "GET /me": () => ({ status: 200, body: { account: { id: "acc", username: "dev" }, caravans: [{ id: CARAVAN, name: "x", region_id: "desert", units: [] }] } }),
      [`GET /caravans/${CARAVAN}/manifest`]: () => ({ status: 200, body: manifestBody }),
      [`GET /me/caravans/${CARAVAN}/encounters/1/candidates`]: () => ({ status: 200, body: { menu: { tripId: "t1", candidates: "nope" } } }),
    });
    mount(fetchImpl);
    expect(await screen.findByTestId("error-box")).toHaveTextContent("bad_payload");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(new ApiError(0, "x", "y").issues).toEqual([]);
  });
});
