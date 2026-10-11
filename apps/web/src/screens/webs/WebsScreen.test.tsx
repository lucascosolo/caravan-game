import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { SessionProvider, useSession } from "../../auth/session.tsx";
import { STRINGS } from "../../strings.ts";
import { fakeFetch, LIVING_SPECS, meResponse, progressionResponse, SIEGE_SPECS, TRAP_SPECS, unlocksResponse, type Handler } from "../../test/fixtures.ts";
import { displayNameOf } from "./catalogue.ts";
import { WebsScreen } from "./WebsScreen.tsx";

/** Signs a fake session in on mount so the screen under test has a bearer token. */
function SignedIn({ children }: { children: JSX.Element }): JSX.Element {
  const { session, signIn } = useSession();
  useEffect(() => {
    if (!session) signIn({ token: "t-123", expiresAt: "2099-01-01T00:00:00Z", account: { id: "a", username: "tester" } });
  }, [session, signIn]);
  return session ? children : <></>;
}

function setup(extra: Record<string, Handler> = {}, state = {}) {
  let current = unlocksResponse(state);
  const routes: Record<string, Handler> = {
    "GET /me/unlocks": () => ({ status: 200, body: current }),
    "GET /me/progression": () => ({ status: 200, body: progressionResponse() }),
    "GET /me": () => ({ status: 200, body: meResponse() }),
    ...extra,
  };
  const ff = fakeFetch(routes);
  const utils = render(
    <SessionProvider fetchImpl={ff.fetch}>
      <SignedIn>
        <WebsScreen />
      </SignedIn>
    </SessionProvider>,
  );
  return { ...utils, calls: ff.calls, setUnlocks: (next: ReturnType<typeof unlocksResponse>) => (current = next) };
}

const w = STRINGS.webs;

describe("WebsScreen", () => {
  it("renders every node of every pool with its cost, including unaffordable and unreachable ones", async () => {
    const user = userEvent.setup();
    setup();
    // Living (default tab): all 8 nodes, with costs from the node payload.
    const living = await screen.findByTestId("web-living");
    for (const spec of LIVING_SPECS) {
      const card = within(living).getByRole("button", { name: new RegExp(`^${displayNameOf(spec.id)},`) });
      expect(card).toBeInTheDocument();
    }
    // The capstone is unreachable AND unaffordable: still rendered, with its cost and reason.
    const vaquero = within(living).getByRole("button", { name: /^Vaquero,/ });
    expect(vaquero).toHaveTextContent(w.cost(14));
    expect(vaquero).toHaveTextContent(w.stateLocked);
    expect(vaquero).toHaveTextContent(`${w.requires}: Canteen Carrier`);
    expect(vaquero).toHaveTextContent(w.lockedMissing("Canteen Carrier"));
    // Scope and points.
    expect(within(living).getByTestId("points-panel")).toHaveTextContent("Caravan-level, Desert only");
    expect(within(living).getByTestId("points-available")).toHaveTextContent("1");
    expect(within(living).getByTestId("next-rung")).toHaveTextContent(w.nextRung(90, 3));

    // Trap pool: 10 nodes, account-level, the tier-4 fence shown with its 10-point cost.
    await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
    const trap = await screen.findByTestId("web-trap");
    for (const spec of TRAP_SPECS) {
      expect(within(trap).getByRole("button", { name: new RegExp(`^${displayNameOf(spec.id)},`) })).toBeInTheDocument();
    }
    expect(within(trap).getByRole("button", { name: /^Stacked Stone,/ })).toHaveTextContent(w.cost(10));
    expect(within(trap).getByRole("button", { name: /^Spike Pit,/ })).toHaveTextContent(w.costFree);
    expect(within(trap).getByTestId("points-panel")).toHaveTextContent(w.scopeAccount);
    // Affordable with 3 points: tripwire (1) yes; split rail (3) yes; jaw trap (1) yes.
    expect(within(trap).getByRole("button", { name: /^Tripwire Snare,/ })).toHaveTextContent(w.stateAffordable);
    expect(within(trap).getByRole("button", { name: /^Split Rail,/ })).toHaveTextContent(w.stateAffordable);
    // Siege: per-pool curve — tier 2 costs 8 here, not the trap web's 3.
    await user.click(screen.getByRole("tab", { name: w.poolName("siege") }));
    const siege = await screen.findByTestId("web-siege");
    for (const spec of SIEGE_SPECS) {
      expect(within(siege).getByRole("button", { name: new RegExp(`^${displayNameOf(spec.id)},`) })).toBeInTheDocument();
    }
    expect(within(siege).getByRole("button", { name: /^Fence Cutters,/ })).toHaveTextContent(w.cost(8));
    expect(within(siege).getByRole("button", { name: /^Bridging Planks,/ })).toHaveTextContent(w.lockedShort(1));
  });

  it("shows the full stat block of a locked node and says unlocking is access, not an instance", async () => {
    const user = userEvent.setup();
    setup();
    const living = await screen.findByTestId("web-living");
    await user.click(within(living).getByRole("button", { name: /^Vaquero,/ }));
    const detail = await screen.findByTestId("node-detail");
    expect(detail).toHaveTextContent(w.accessNote);
    expect(detail).toHaveTextContent(w.kindUnit);
    for (const label of [w.stat.offense, w.stat.defense, w.stat.hp, w.stat.moveSpeed, w.stat.attackRange, w.stat.attackCooldown, w.stat.ability, w.stat.cooldown]) {
      expect(within(detail).getByText(label)).toBeInTheDocument();
    }
    // No unlock button on a locked node: the server said it is not affordable.
    expect(within(detail).queryByRole("button", { name: /^Unlock access/ })).not.toBeInTheDocument();
  });

  it("confirms before spending, sends the exact request, then re-fetches rather than updating optimistically", async () => {
    const user = userEvent.setup();
    let posted = 0;
    const { calls, setUnlocks } = setup({
      "POST /me/unlocks/spend": (call) => {
        posted++;
        setUnlocks(unlocksResponse({ trapPurchased: ["trap.tripwire_snare"] }));
        return { status: 201, body: { created: true, webId: "trap", pool: "trap", node: {}, points: { granted: 3, spent: 1, available: 2 }, nodes: [], echo: call.body } };
      },
    });
    await screen.findByTestId("web-living");
    await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
    const trap = await screen.findByTestId("web-trap");
    await user.click(within(trap).getByRole("button", { name: /^Tripwire Snare,/ }));
    const detail = await screen.findByTestId("node-detail");
    await user.click(within(detail).getByRole("button", { name: w.unlockButton("Tripwire Snare", 1) }));

    // The confirm step: cost, points available and remainder shown; nothing sent yet.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(w.confirmBody("Tripwire Snare", 1, 3));
    expect(posted).toBe(0);

    // Cancel sends nothing.
    await user.click(within(dialog).getByRole("button", { name: w.confirmNo }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posted).toBe(0);

    // Confirm sends exactly one POST with the server's shape (account web: no caravanId).
    await user.click(within(detail).getByRole("button", { name: w.unlockButton("Tripwire Snare", 1) }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: w.confirmYes }));
    await waitFor(() => expect(posted).toBe(1));
    const post = calls.find((c) => c.method === "POST" && c.path === "/me/unlocks/spend")!;
    expect(post.body).toEqual({ pool: "trap", nodeId: "trap.tripwire_snare" });
    expect(post.headers["Authorization"]).toBe("Bearer t-123");

    // Re-fetched: a second GET /me/unlocks after the POST, and the new state is what shows.
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/me/unlocks").length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(within(screen.getByTestId("web-trap")).getByRole("button", { name: /^Tripwire Snare,/ })).toHaveTextContent(w.stateReached));
    expect(within(screen.getByTestId("web-trap")).getByTestId("points-available")).toHaveTextContent("2");
    expect(screen.getByRole("status")).toHaveTextContent(w.spendDone("Tripwire Snare"));
  });

  it("names the caravan on a living-web spend", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      "POST /me/unlocks/spend": () => ({ status: 201, body: { created: true } }),
    });
    const living = await screen.findByTestId("web-living");
    await user.click(within(living).getByRole("button", { name: /^Sand Sharpshooter,/ }));
    await user.click(within(await screen.findByTestId("node-detail")).getByRole("button", { name: w.unlockButton("Sand Sharpshooter", 1) }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: w.confirmYes }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ pool: "living", nodeId: "desert.sand_sharpshooter", caravanId: "22222222-2222-4222-8222-222222222222" });
  });

  it("surfaces the server's exact error on a refused spend", async () => {
    const user = userEvent.setup();
    const message = "'trap.tripwire_snare' costs 1 unlock points; 0 available";
    setup({
      "POST /me/unlocks/spend": () => ({ status: 409, body: { error: "insufficient_points", message } }),
    });
    await screen.findByTestId("web-living");
    await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
    const trap = await screen.findByTestId("web-trap");
    await user.click(within(trap).getByRole("button", { name: /^Tripwire Snare,/ }));
    await user.click(within(await screen.findByTestId("node-detail")).getByRole("button", { name: w.unlockButton("Tripwire Snare", 1) }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: w.confirmYes }));
    const err = await screen.findByTestId("api-error");
    expect(within(err).getByTestId("api-error-message")).toHaveTextContent(message);
    expect(err).toHaveTextContent("409 insufficient_points");
    expect(err).toHaveTextContent(w.spendFailed);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the load error with a retry when the webs cannot be read", async () => {
    setup({ "GET /me/unlocks": () => ({ status: 500, body: { error: "internal", message: "internal error" } }) });
    const err = await screen.findByTestId("api-error");
    expect(err).toHaveTextContent("internal error");
    expect(screen.getByRole("button", { name: STRINGS.app.retry })).toBeInTheDocument();
  });
});
