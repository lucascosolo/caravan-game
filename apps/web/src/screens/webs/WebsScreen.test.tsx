import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { SessionProvider, useSession } from "../../auth/session.tsx";
import { STRINGS } from "../../strings.ts";
import {
  fakeFetch,
  LIVING_SPECS,
  meResponse,
  progressionResponse,
  SIEGE_SPECS,
  spendResult,
  TRAP_SPECS,
  unlocksResponse,
  type Handler,
} from "../../test/fixtures.ts";
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
  let current: unknown = unlocksResponse(state);
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
  return { ...utils, calls: ff.calls, setUnlocks: (next: unknown) => (current = next) };
}

const w = STRINGS.webs;
const card = (name: string) => ({ name: new RegExp(`^${name}\\b`) });
const getsOf = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "GET" && c.path === "/me/unlocks").length;

describe("WebsScreen", () => {
  it("renders every node of every pool with its cost, including unaffordable and unreachable ones", async () => {
    const user = userEvent.setup();
    setup();
    // Living (default tab): all 8 nodes, with costs from the node payload.
    const living = await screen.findByTestId("web-living");
    for (const spec of LIVING_SPECS) {
      expect(within(living).getByRole("button", card(displayNameOf(spec.id)))).toBeInTheDocument();
    }
    // The capstone is unreachable AND unaffordable: still rendered, with its cost and reason.
    const vaquero = within(living).getByRole("button", card("Vaquero"));
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
      expect(within(trap).getByRole("button", card(displayNameOf(spec.id)))).toBeInTheDocument();
    }
    expect(within(trap).getByRole("button", card("Stacked Stone"))).toHaveTextContent(w.cost(10));
    expect(within(trap).getByRole("button", card("Spike Pit"))).toHaveTextContent(w.costFree);
    expect(within(trap).getByTestId("points-panel")).toHaveTextContent(w.scopeAccount);
    // Affordable with 3 points: tripwire (1) yes; split rail (3) yes; jaw trap (1) yes.
    expect(within(trap).getByRole("button", card("Tripwire Snare"))).toHaveTextContent(w.stateAffordable);
    expect(within(trap).getByRole("button", card("Split Rail"))).toHaveTextContent(w.stateAffordable);
    // Siege: per-pool curve — tier 2 costs 8 here, not the trap web's 3.
    await user.click(screen.getByRole("tab", { name: w.poolName("siege") }));
    const siege = await screen.findByTestId("web-siege");
    for (const spec of SIEGE_SPECS) {
      expect(within(siege).getByRole("button", card(displayNameOf(spec.id)))).toBeInTheDocument();
    }
    expect(within(siege).getByRole("button", card("Fence Cutters"))).toHaveTextContent(w.cost(8));
    // Locked for points only: the server said "not affordable" and nothing is missing; the client names no shortfall (S7).
    const planks = within(siege).getByRole("button", card("Bridging Planks"));
    expect(planks).toHaveTextContent(w.lockedPoints);
    expect(planks).not.toHaveTextContent(/more point/);
  });

  it("shows the full stat block of a locked node and says unlocking is access, not an instance", async () => {
    const user = userEvent.setup();
    setup();
    const living = await screen.findByTestId("web-living");
    await user.click(within(living).getByRole("button", card("Vaquero")));
    const detail = await screen.findByTestId("node-detail");
    expect(detail).toHaveTextContent(w.accessNote);
    expect(detail).toHaveTextContent(w.kindUnit);
    for (const label of [w.stat.offense, w.stat.defense, w.stat.hp, w.stat.moveSpeed, w.stat.attackRange, w.stat.attackCooldown, w.stat.ability, w.stat.cooldown]) {
      expect(within(detail).getByText(label)).toBeInTheDocument();
    }
    // No unlock button on a locked node: the server said it is not affordable.
    expect(within(detail).queryByRole("button", { name: /^Unlock access/ })).not.toBeInTheDocument();
  });

  it("words the reached-state line by what the node grants (S6)", async () => {
    const user = userEvent.setup();
    setup();
    const living = await screen.findByTestId("web-living");
    await user.click(within(living).getByRole("button", card("Dust Rider")));
    expect(await screen.findByTestId("node-detail")).toHaveTextContent(w.accessGranted("unit"));
    await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
    const trap = await screen.findByTestId("web-trap");
    await user.click(within(trap).getByRole("button", card("Spike Pit")));
    expect(await screen.findByTestId("node-detail")).toHaveTextContent(w.accessGranted("trap"));
    await user.click(within(trap).getByRole("button", card("Brush Pile")));
    expect(await screen.findByTestId("node-detail")).toHaveTextContent(w.accessGranted("fence"));
    await user.click(screen.getByRole("tab", { name: w.poolName("siege") }));
    const siege = await screen.findByTestId("web-siege");
    await user.click(within(siege).getByRole("button", card("Battering Wagon")));
    expect(await screen.findByTestId("node-detail")).toHaveTextContent(w.accessGranted("siege"));
    for (const kind of ["unit", "trap", "fence", "siege"] as const) expect(w.accessGranted(kind)).toMatch(/no instance/);
  });

  it("re-fetches before the confirm, sends the exact request on confirm, then re-fetches rather than updating optimistically", async () => {
    const user = userEvent.setup();
    let posted = 0;
    const { calls, setUnlocks } = setup({
      "POST /me/unlocks/spend": () => {
        posted++;
        setUnlocks(unlocksResponse({ trapPurchased: ["trap.tripwire_snare"] }));
        return { status: 201, body: spendResult("trap", "trap.tripwire_snare", { trapPurchased: ["trap.tripwire_snare"] }) };
      },
    });
    await screen.findByTestId("web-living");
    await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
    const trap = await screen.findByTestId("web-trap");
    await user.click(within(trap).getByRole("button", card("Tripwire Snare")));
    const detail = await screen.findByTestId("node-detail");
    const getsBeforeUnlock = getsOf(calls);
    await user.click(within(detail).getByRole("button", { name: w.unlockButton("Tripwire Snare", 1) }));

    // The confirm step opens only after a fresh read (N8) and quotes cost + available; nothing sent yet.
    const dialog = await screen.findByRole("dialog");
    expect(getsOf(calls)).toBe(getsBeforeUnlock + 1);
    expect(dialog).toHaveTextContent(w.confirmBody("Tripwire Snare", 1, 3));
    expect(dialog).not.toHaveTextContent(/will remain/);
    expect(posted).toBe(0);

    // Cancel sends nothing.
    await user.click(within(dialog).getByRole("button", { name: w.confirmNo }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posted).toBe(0);

    // Confirm sends exactly one POST with the server's shape (account web: no caravanId).
    await user.click(within(detail).getByRole("button", { name: w.unlockButton("Tripwire Snare", 1) }));
    const getsBeforeConfirm = getsOf(calls);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: w.confirmYes }));
    await waitFor(() => expect(posted).toBe(1));
    const post = calls.find((c) => c.method === "POST" && c.path === "/me/unlocks/spend")!;
    expect(post.body).toEqual({ pool: "trap", nodeId: "trap.tripwire_snare" });
    expect(post.headers["Authorization"]).toBe("Bearer t-123");

    // Re-fetched: another GET /me/unlocks after the POST, and the new state is what shows.
    await waitFor(() => expect(getsOf(calls)).toBe(getsBeforeConfirm + 1));
    await waitFor(() => expect(within(screen.getByTestId("web-trap")).getByRole("button", card("Tripwire Snare"))).toHaveTextContent(w.stateReached));
    expect(within(screen.getByTestId("web-trap")).getByTestId("points-available")).toHaveTextContent("2");
    // The remaining balance in the notice is the spend response's number (S7), not cost arithmetic.
    expect(screen.getByRole("status")).toHaveTextContent(w.spendDone("Tripwire Snare", 2));
  });

  it("opens no confirm when the pre-confirm re-fetch finds the node no longer affordable (N8)", async () => {
    const user = userEvent.setup();
    let posted = 0;
    const { setUnlocks } = setup({ "POST /me/unlocks/spend": () => ((posted++, { status: 201, body: {} })) });
    await screen.findByTestId("web-living");
    await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
    const trap = await screen.findByTestId("web-trap");
    await user.click(within(trap).getByRole("button", card("Split Rail")));
    const detail = await screen.findByTestId("node-detail");
    // Meanwhile the points were spent elsewhere (another device): the next read says 0 available.
    setUnlocks(unlocksResponse({ trapPurchased: ["trap.tripwire_snare", "trap.jaw_trap"], trapGranted: 2 }));
    await user.click(within(detail).getByRole("button", { name: w.unlockButton("Split Rail", 3) }));
    expect(await screen.findByRole("status")).toHaveTextContent(w.spendStale("Split Rail"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posted).toBe(0);
    // The fresh state is what shows: no unlock button any more.
    await waitFor(() => expect(within(screen.getByTestId("node-detail")).queryByRole("button", { name: /^Unlock access/ })).not.toBeInTheDocument());
    expect(within(screen.getByTestId("web-trap")).getByTestId("points-available")).toHaveTextContent("0");
  });

  it("names the caravan on a living-web spend", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      "POST /me/unlocks/spend": () => ({ status: 201, body: spendResult("living", "desert.sand_sharpshooter", { livingPurchased: ["desert.sand_sharpshooter"] }) }),
    });
    const living = await screen.findByTestId("web-living");
    await user.click(within(living).getByRole("button", card("Sand Sharpshooter")));
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
    await user.click(within(trap).getByRole("button", card("Tripwire Snare")));
    await user.click(within(await screen.findByTestId("node-detail")).getByRole("button", { name: w.unlockButton("Tripwire Snare", 1) }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: w.confirmYes }));
    const err = await screen.findByTestId("api-error");
    expect(within(err).getByTestId("api-error-message")).toHaveTextContent(message);
    expect(err).toHaveTextContent("409 insufficient_points");
    expect(err).toHaveTextContent(w.spendFailed);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the load error with a retry when the webs cannot be read", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { calls } = setup({ "GET /me/unlocks": () => (fail ? { status: 500, body: { error: "internal", message: "internal error" } } : { status: 200, body: unlocksResponse() }) });
    const err = await screen.findByTestId("api-error");
    expect(err).toHaveTextContent("internal error");
    fail = false;
    await user.click(screen.getByRole("button", { name: STRINGS.app.retry }));
    expect(await screen.findByTestId("web-living")).toBeInTheDocument();
    expect(getsOf(calls)).toBe(2);
  });

  describe("malformed payloads (B1): the error UI with Retry, never a blank page", () => {
    const base = unlocksResponse();
    const withNode = (patch: Record<string, unknown>) => {
      const node = { ...base.webs[0]!.nodes[0]!, ...patch };
      return { webs: [{ ...base.webs[0]!, nodes: [node, ...base.webs[0]!.nodes.slice(1)] }, ...base.webs.slice(1)] };
    };
    const cases: [string, string, unknown][] = [
      ["unlocks: webs not an array", "GET /me/unlocks", { webs: {} }],
      ["unlocks: body is HTML", "GET /me/unlocks", "<html><body>502 Bad Gateway</body></html>"],
      ["unlocks: body is null", "GET /me/unlocks", null],
      ["unlocks: node tier -1", "GET /me/unlocks", withNode({ tier: -1 })],
      ["unlocks: node tier 1e7", "GET /me/unlocks", withNode({ tier: 10_000_000 })],
      ["unlocks: node tier 2.5", "GET /me/unlocks", withNode({ tier: 2.5 })],
      ["unlocks: node cost is a string", "GET /me/unlocks", withNode({ cost: "1" })],
      ["unlocks: node missing requires/missing", "GET /me/unlocks", withNode({ requires: undefined, missing: undefined })],
      ["unlocks: node id not a string", "GET /me/unlocks", withNode({ id: 7 })],
      ["unlocks: points available is a string", "GET /me/unlocks", { webs: [{ ...base.webs[0]!, points: { granted: "6", spent: "0", available: "6" } }] }],
      ["unlocks: unknown pool", "GET /me/unlocks", { webs: [{ ...base.webs[0]!, pool: "mounts" }] }],
      ["progression: pools missing", "GET /me/progression", { webs: [] }],
      ["progression: ladder missing", "GET /me/progression", { pools: [{ ...progressionResponse().pools[0]!, ladder: undefined }] }],
      ["me: caravans missing", "GET /me", { account: { id: "a", username: "tester" } }],
      ["me: account missing", "GET /me", { caravans: [] }],
    ];
    for (const [name, route, body] of cases) {
      it(name, async () => {
        const user = userEvent.setup();
        let bad = true;
        const good: Record<string, unknown> = { "GET /me/unlocks": unlocksResponse(), "GET /me/progression": progressionResponse(), "GET /me": meResponse() };
        const { container } = setup({ [route]: () => ({ status: 200, body: bad ? body : good[route] }) });
        const err = await screen.findByTestId("api-error");
        expect(within(err).getByTestId("api-error-message")).toHaveTextContent(STRINGS.app.badPayload);
        expect(err).toHaveTextContent("bad_payload");
        expect(err).toHaveTextContent(route);
        expect(container).not.toBeEmptyDOMElement();
        expect(screen.queryByTestId("web-living")).not.toBeInTheDocument();
        // Retry with a good answer recovers without a reload.
        bad = false;
        await user.click(screen.getByRole("button", { name: STRINGS.app.retry }));
        expect(await screen.findByTestId("web-living")).toBeInTheDocument();
        expect(screen.queryByTestId("api-error")).not.toBeInTheDocument();
      });
    }

    it("spend: a malformed spend answer is an error, and the webs are re-read", async () => {
      const user = userEvent.setup();
      const { calls } = setup({ "POST /me/unlocks/spend": () => ({ status: 201, body: { created: true } }) });
      await screen.findByTestId("web-living");
      await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
      await user.click(within(await screen.findByTestId("web-trap")).getByRole("button", card("Tripwire Snare")));
      await user.click(within(await screen.findByTestId("node-detail")).getByRole("button", { name: w.unlockButton("Tripwire Snare", 1) }));
      const getsBefore = getsOf(calls);
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: w.confirmYes }));
      const err = await screen.findByTestId("api-error");
      expect(err).toHaveTextContent(w.spendFailed);
      expect(err).toHaveTextContent("bad_payload");
      await waitFor(() => expect(getsOf(calls)).toBe(getsBefore + 1));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("a node id the catalogue does not know is shown as text, never as markup", async () => {
      const user = userEvent.setup();
      // withNode patches the first web of the fixture, which is the trap web.
      const { container } = setup({ "GET /me/unlocks": () => ({ status: 200, body: withNode({ id: "<img src=x onerror=alert(1)>", requires: ["<b>bold</b>"] }) }) });
      await screen.findByTestId("web-living");
      await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
      const trap = await screen.findByTestId("web-trap");
      expect(within(trap).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
      expect(within(trap).getByText(`${w.requires}: <b>bold</b>`)).toBeInTheDocument();
      expect(container.querySelector("img, b")).toBeNull();
    });
  });

  describe("accessibility (S1–S4)", () => {
    it("S2: a card's accessible name is its content — name, cost, state, prerequisites and lock reason", async () => {
      setup();
      const living = await screen.findByTestId("web-living");
      const vaquero = within(living).getByRole("button", card("Vaquero"));
      expect(vaquero).toHaveAccessibleName(`Vaquero Grit ${w.cost(14)} ${w.stateLocked} ${w.requires}: Canteen Carrier ${w.lockedMissing("Canteen Carrier")}`);
      expect(vaquero).not.toHaveAttribute("aria-label");
      // Glyphs are hidden from the name: no ✓ → ⊘ and no SVG text.
      for (const b of within(living).getAllByRole("button")) expect(b).not.toHaveAccessibleName(/[✓→⊘]/);
      const rider = within(living).getByRole("button", card("Dust Rider"));
      expect(rider).toHaveAccessibleName(`Dust Rider Beast ${w.costFree} ${w.stateReached} ${w.requiresNone}`);
    });

    it("S3: pool tabs are a roving tab stop wired to their panel, with arrow keys", async () => {
      const user = userEvent.setup();
      setup();
      await screen.findByTestId("web-living");
      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
      expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[0]!.id);
      expect(tabs[0]).toHaveAttribute("aria-controls", screen.getByRole("tabpanel").id);
      tabs[0]!.focus();
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab", { name: w.poolName("trap") })).toHaveFocus();
      expect(screen.getByRole("tab", { name: w.poolName("trap") })).toHaveAttribute("aria-selected", "true");
      expect(await screen.findByTestId("web-trap")).toBeInTheDocument();
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab", { name: w.poolName("siege") })).toHaveFocus();
      expect(await screen.findByTestId("web-siege")).toBeInTheDocument();
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab", { name: w.poolName("living") })).toHaveFocus();
      await user.keyboard("{ArrowLeft}");
      expect(screen.getByRole("tab", { name: w.poolName("siege") })).toHaveFocus();
      await user.keyboard("{Home}");
      expect(screen.getByRole("tab", { name: w.poolName("living") })).toHaveFocus();
      await user.keyboard("{End}");
      expect(screen.getByRole("tab", { name: w.poolName("siege") })).toHaveFocus();
      expect(screen.getAllByRole("tab").map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
      // Tab leaves the tablist in one step (the other tabs are not stops).
      await user.tab();
      expect(screen.getByRole("tab", { name: w.poolName("siege") })).not.toHaveFocus();
      expect(document.activeElement?.getAttribute("role")).not.toBe("tab");
    });

    it("S4: the sheet takes focus on its heading when opened and gives it back to the card when closed", async () => {
      const user = userEvent.setup();
      setup();
      const living = await screen.findByTestId("web-living");
      const vaquero = within(living).getByRole("button", card("Vaquero"));
      await user.click(vaquero);
      const detail = await screen.findByTestId("node-detail");
      expect(within(detail).getByRole("heading", { level: 2, name: "Vaquero" })).toHaveFocus();
      // Switching to another node moves focus to the new heading.
      const rider = within(living).getByRole("button", card("Dust Rider"));
      await user.click(rider);
      expect(within(screen.getByTestId("node-detail")).getByRole("heading", { level: 2, name: "Dust Rider" })).toHaveFocus();
      await user.click(screen.getByRole("button", { name: w.close }));
      expect(screen.queryByTestId("node-detail")).not.toBeInTheDocument();
      expect(rider).toHaveFocus();
    });

    it("S1: the confirm dialog traps focus, inerts the page, describes itself, and restores focus to the opener", async () => {
      const user = userEvent.setup();
      const { container } = setup();
      await screen.findByTestId("web-living");
      await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
      await user.click(within(await screen.findByTestId("web-trap")).getByRole("button", card("Tripwire Snare")));
      const unlock = within(await screen.findByTestId("node-detail")).getByRole("button", { name: w.unlockButton("Tripwire Snare", 1) });
      await user.click(unlock);
      const dialog = await screen.findByRole("dialog");
      const cancel = within(dialog).getByRole("button", { name: w.confirmNo });
      const confirm = within(dialog).getByRole("button", { name: w.confirmYes });
      // Opens on Cancel (the safe choice), described by its body, and the app behind it is inert.
      expect(cancel).toHaveFocus();
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog).toHaveAccessibleName(w.confirmQuestion("Tripwire Snare"));
      expect(dialog).toHaveAccessibleDescription(w.confirmBody("Tripwire Snare", 1, 3));
      expect(container.parentElement).not.toBe(dialog.parentElement);
      expect(container).toHaveAttribute("inert");
      expect(dialog.closest(".cv-sheet-host")).not.toHaveAttribute("inert");
      // Tab cycles inside the sheet (its resize peg and close medallion come first): Cancel → Spend → wraps → … → Cancel.
      await user.tab();
      expect(confirm).toHaveFocus();
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      await user.tab({ shift: true });
      expect(confirm).toHaveFocus();
      await user.tab({ shift: true });
      expect(cancel).toHaveFocus();
      // Escape closes it, the page is live again and focus is back on the Unlock button.
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(container).not.toHaveAttribute("inert");
      expect(unlock).toHaveFocus();
      expect(document.querySelector(".cv-sheet-host")).toBeNull();
    });

    it("S1: after a successful spend the opener is gone, so focus lands on the sheet heading", async () => {
      const user = userEvent.setup();
      const { setUnlocks } = setup({
        "POST /me/unlocks/spend": () => {
          setUnlocks(unlocksResponse({ trapPurchased: ["trap.tripwire_snare"] }));
          return { status: 201, body: spendResult("trap", "trap.tripwire_snare", { trapPurchased: ["trap.tripwire_snare"] }) };
        },
      });
      await screen.findByTestId("web-living");
      await user.click(screen.getByRole("tab", { name: w.poolName("trap") }));
      await user.click(within(await screen.findByTestId("web-trap")).getByRole("button", card("Tripwire Snare")));
      await user.click(within(await screen.findByTestId("node-detail")).getByRole("button", { name: w.unlockButton("Tripwire Snare", 1) }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: w.confirmYes }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(within(screen.getByTestId("node-detail")).getByRole("heading", { level: 2, name: "Tripwire Snare" })).toHaveFocus());
    });
  });
});
