/**
 * Chunk 24's screens: the first screen comes before any tab for a new account and cannot be
 * skipped; the guide's cards move on from the SERVER's state; skip asks first; the guided
 * arrangement edits the circle through the formation screen's own model; a finished account
 * sees no guide. No storage of any kind is touched.
 */
import { raiseOrder } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../api/client.ts";
import type { ManifestView } from "../api/types.ts";
import { App } from "../App.tsx";
import type { IsoCanvasProps } from "../iso/index.ts";
import { FormationScreen, clearLocalDrafts } from "../screens/trail/FormationScreen.tsx";
import { fixtureEncounter } from "../screens/trail/scoutFixture.ts";
import { packedManifest } from "../test/circleFixtures.ts";
import authJson from "../test/contract/auth-login.json";
import { CARAVAN_ID, fakeFetch, meResponse, type Call } from "../test/fixtures.ts";
import { fakeApi, meWith } from "../test/townFixtures.ts";
import { previewAfter1, statusArranging, statusBanked, statusDecide, statusOverrun, statusPacked, statusVoided, withTrip } from "../test/tripFixtures.ts";
import refugeesJson from "../test/contract/refugees.json";
import { expectShape } from "../api/shape.ts";
import { partyShape } from "../api/shapes.ts";
import partyJson from "../test/contract/party.json";
import { ShellGuide } from "./ShellGuide.tsx";
import { TrailScreen } from "../screens/trail/TrailScreen.tsx";
import { OnboardingProvider } from "./OnboardingProvider.tsx";
import { ONBOARDING_STEPS, stepRank, type OnboardingStep } from "./steps.ts";
import { ArrangeGuide } from "./TrailGuide.tsx";

vi.mock("../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../iso/index.ts")>("../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(props, _ref) {
    return <div data-testid="iso-canvas" data-fences={props.state.fences.length} data-posts={props.state.posts.length} data-traps={props.state.traps.length} />;
  });
  return { ...actual, IsoCanvas };
});
// The town's own screen is tested in TownScreen.test; here it is a stand-in so the shell's guide is what is under test.
vi.mock("../screens/town/TownScreen.tsx", () => ({ TownScreen: () => <section data-testid="town-screen">town</section> }));

function onboardingBody(step: OnboardingStep, skipped = false) {
  return { step, steps: [...ONBOARDING_STEPS], enrolled: true, completed: step === "done", skipped, canSkip: step !== "welcome" && step !== "done", updatedAt: "2026-10-11T12:00:00.000Z" };
}

/** A server that keeps the account's guide step, forward-only, as the real one does. */
function server(start: OnboardingStep, opts: { units?: () => number; claimed?: () => boolean } = {}) {
  let step = start;
  let skipped = false;
  const ff = fakeFetch({
    "POST /auth/login": () => ({ status: 200, body: authJson.body }),
    "GET /me/onboarding": () => ({ status: 200, body: { onboarding: onboardingBody(step, skipped) } }),
    "POST /me/onboarding/advance": (c: Call) => {
      const want = (c.body as { step: OnboardingStep }).step;
      const changed = stepRank(want) > stepRank(step);
      if (changed) step = want;
      return { status: 200, body: { onboarding: onboardingBody(step, skipped), changed } };
    },
    "POST /me/onboarding/skip": () => {
      if (step === "welcome") return { status: 409, body: { error: "onboarding_first_screen", message: "no" } };
      step = "done";
      skipped = true;
      return { status: 200, body: { onboarding: onboardingBody(step, true), changed: true } };
    },
    "GET /me": () => {
      const me = meResponse();
      const n = opts.units?.() ?? 0;
      return { status: 200, body: { ...me, caravans: me.caravans.map((c) => ({ ...c, units: Array.from({ length: n }, (_, i) => ({ id: `u${i}`, caravan_id: CARAVAN_ID, unit_type_id: "desert.dust_rider", merge_level: 1 })) })) } };
    },
    [`GET /me/caravans/${CARAVAN_ID}/trip`]: () => ({ status: 200, body: withTrip(statusPacked(), null) }),
    [`GET /me/caravans/${CARAVAN_ID}/refugees`]: () => {
      const body = structuredClone(refugeesJson.body) as { caravanId: string; menu: { claimed: unknown } };
      body.caravanId = CARAVAN_ID;
      body.menu.claimed = opts.claimed?.() ? { unitTypeId: "desert.dust_rider", instanceId: "00000000-0000-4000-8000-0000000000aa", claimedAtMs: 1790000000500 } : null;
      return { status: 200, body };
    },
  });
  return { ...ff, step: () => step };
}

async function signIn(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Username"), "newbie");
  await user.type(screen.getByLabelText("Password"), "correct horse battery");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

let setItem: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  window.history.replaceState(null, "", "#/webs");
  setItem = vi.spyOn(Storage.prototype, "setItem");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the first session (chunk 24)", () => {
  it("shows the first screen before any tab, says which side is played live and which runs while away, and the region is permanent", async () => {
    const s = server("welcome");
    render(<App fetchImpl={s.fetch} />);
    await signIn();
    const welcome = await screen.findByTestId("onboarding-welcome");
    // QA N7: the first screen comes before any tab, so no tab bar is drawn under it.
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    // QA N9: a plan, not a promise of a hold.
    expect(welcome).toHaveTextContent("then bank if you are still standing");
    expect(welcome.textContent).not.toMatch(/hold two encounters/i);
    expect(welcome).toHaveTextContent("You play defense, live");
    expect(welcome).toHaveTextContent("Your raid party works while you are away");
    expect(welcome).toHaveTextContent("Your town is never raided");
    await waitFor(() => expect(screen.getByTestId("welcome-region")).toHaveTextContent("Your caravan rides the"));
    expect(screen.getByTestId("welcome-region")).toHaveTextContent("permanent for this caravan");
    // No skip on the first screen (PHASE-2 §24: skippable after it).
    expect(screen.queryByTestId("guide-skip")).toBeNull();
    // Guardrail 0 copy: no "base", no "camp", the player attacks nothing.
    expect(welcome.textContent).not.toMatch(/\b(base|camp|attack)\b/i);

    await userEvent.setup().click(screen.getByTestId("welcome-begin"));
    await screen.findByTestId("guide-roster");
    expect(s.step()).toBe("roster");
    expect(window.location.hash).toBe("#/town");
    expect(screen.getByTestId("town-screen")).toBeInTheDocument();
    expect(screen.getByTestId("guide-skip")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("moves from 'take a refugee' to 'pack and ride out' only when the server says a refugee was claimed — the starting roster alone does not", async () => {
    let claimed = false;
    // Every caravan starts with its starting roster (chunk 24 QA D1): units are there from the start.
    const s = server("roster", { units: () => (claimed ? 3 : 2), claimed: () => claimed });
    window.history.replaceState(null, "", "#/town");
    render(<App fetchImpl={s.fetch} />);
    await signIn();
    const card = await screen.findByTestId("guide-roster");
    expect(card).toHaveTextContent("starting roster");
    expect(card).not.toHaveTextContent("Your roster is empty");
    // r4 N9: on Town the card's button brings the Refugees panel into view.
    const scrolled = vi.fn();
    const panel = screen.queryByTestId("refugee-panel") ?? document.body.appendChild(Object.assign(document.createElement("section"), { id: "r4n9" }));
    panel.setAttribute("data-testid", "refugee-panel");
    panel.scrollIntoView = scrolled;
    within(card).getByTestId("guide-roster-show").click();
    expect(scrolled).toHaveBeenCalled();
    document.getElementById("r4n9")?.remove();
    // Another tab change re-reads the server: the starting roster is there, no claim yet, still this step.
    window.location.hash = "#/webs";
    await waitFor(() => expect(s.calls.filter((c) => c.path === "/me").length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(s.calls.filter((c) => c.path.endsWith("/refugees")).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("guide-roster")).toBeInTheDocument();
    expect(s.step()).toBe("roster");
    claimed = true; // the player took a refugee (the ordinary claim route; the guide grants nothing)
    window.location.hash = "#/town";
    await screen.findByTestId("guide-outfit");
    expect(s.step()).toBe("outfit");
    expect(s.calls.filter((c) => c.method === "POST" && !c.path.startsWith("/me/onboarding") && c.path !== "/auth/login")).toEqual([]);
  });

  it("skip asks first, then the guide is gone for this account", async () => {
    const s = server("outfit");
    window.history.replaceState(null, "", "#/town");
    render(<App fetchImpl={s.fetch} />);
    await signIn();
    const card = await screen.findByTestId("guide-outfit");
    const user = userEvent.setup();
    await user.click(within(card).getByTestId("guide-skip"));
    const dialog = await screen.findByRole("dialog", { name: "Skip the rest of the guide?" });
    expect(s.calls.some((c) => c.path === "/me/onboarding/skip")).toBe(false);
    await user.click(within(dialog).getByTestId("guide-skip-confirm"));
    await waitFor(() => expect(screen.queryByTestId("guide-outfit")).toBeNull());
    expect(s.step()).toBe("done");
  });

  it("an account that finished (or skipped) sees no guide and no first screen", async () => {
    const s = server("done");
    window.history.replaceState(null, "", "#/town");
    render(<App fetchImpl={s.fetch} />);
    await signIn();
    await screen.findByTestId("town-screen");
    await waitFor(() => expect(s.calls.some((c) => c.path === "/me/onboarding")).toBe(true));
    expect(screen.queryByTestId("onboarding-welcome")).toBeNull();
    expect(document.querySelector(".guide")).toBeNull();
  });

  it("a guide whose state cannot be read stays out of the way (fail-open)", async () => {
    const ff = fakeFetch({ "POST /auth/login": () => ({ status: 200, body: authJson.body }), "GET /me/onboarding": () => ({ status: 500, body: { error: "internal", message: "x" } }) });
    window.history.replaceState(null, "", "#/town");
    render(<App fetchImpl={ff.fetch} />);
    await signIn();
    await screen.findByTestId("town-screen");
    expect(screen.queryByTestId("onboarding-welcome")).toBeNull();
    expect(document.querySelector(".guide")).toBeNull();
  });

  it("QA N6: one transient failure of the first read is retried, so a new account still sees the first screen; a 4xx is not retried", async () => {
    let n = 0;
    const flaky = vi.fn(async () => {
      n++;
      if (n === 1) throw new ApiError(503, "unavailable", "try again");
      return { onboarding: onboardingBody("welcome") };
    });
    const api = fakeApi({ onboarding: flaky });
    const Probe = (): JSX.Element => <ShellGuide api={api} route="town" />;
    render(
      <OnboardingProvider api={api} retryMs={[5, 5]}>
        <Probe />
      </OnboardingProvider>,
    );
    await waitFor(() => expect(flaky).toHaveBeenCalledTimes(2));
    const refused = vi.fn(async () => {
      throw new ApiError(401, "unauthorized", "no");
    });
    const api2 = fakeApi({ onboarding: refused });
    render(
      <OnboardingProvider api={api2} retryMs={[5, 5]}>
        <ShellGuide api={api2} route="town" />
      </OnboardingProvider>,
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe("the guided arrangement on the formation screen (chunk 24)", () => {
  beforeEach(() => clearLocalDrafts());

  function trip(): ManifestView {
    const m = packedManifest();
    return { id: "m1", caravanId: "c1", encountersResolved: 0, createdAt: "", closedAt: null, packed: m, survivors: m, summary: { unitsAlive: 3, unitsDead: 0, trapsUnspent: 2, trapsSpent: 0, fencesIntact: 20, fencesDestroyed: 0 }, formations: [] };
  }

  it("each step is a button that edits the circle through the screen's own model, and ticks off from the arrangement", async () => {
    const api: Api = fakeApi();
    const scout = fixtureEncounter(1);
    render(<FormationScreen api={api} caravanId="c1" trip={trip()} encounterIndex={1} initial={null} scout={scout} autosaveMs={3_600_000} guide={(g) => <ArrangeGuide {...g} scout={scout.scout} />} />);
    const guide = screen.getByTestId("guide-arrange");
    // QA N3: number agreement, and edge names lower case mid-sentence.
    expect(guide).toHaveTextContent("2 of the 3 raiders start on the north side");
    const user = userEvent.setup();
    expect(screen.getByTestId("guide-step-fence")).toHaveAttribute("data-done", "false");
    // QA S4: the next step, and only it, is shown in full right under the circle; the rest are folded away.
    expect(within(screen.getByTestId("guide-current")).getByTestId("guide-step-fence")).toBeInTheDocument();
    expect(screen.getByTestId("guide-next-step")).toHaveTextContent("Step 1 of 5");
    expect(screen.getByTestId("guide-all-steps")).not.toHaveAttribute("open");
    await user.click(screen.getByTestId("guide-do-fence"));
    expect(within(screen.getByTestId("guide-current")).getByTestId("guide-step-post")).toBeInTheDocument();
    expect(screen.getByTestId("guide-step-fence")).toHaveAttribute("data-done", "true");
    expect(screen.getByTestId("budget-meter")).toHaveTextContent("6 of 20 segments placed");
    expect(screen.getByTestId("guide-step-gap")).toHaveAttribute("data-done", "true");
    await user.click(screen.getByTestId("guide-do-post"));
    expect(screen.getByTestId("guide-step-post")).toHaveAttribute("data-done", "true");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-posts", "3");
    await user.click(screen.getByTestId("guide-do-trap"));
    expect(screen.getByTestId("guide-step-trap")).toHaveAttribute("data-done", "true");
    expect(screen.getByTestId("iso-canvas")).toHaveAttribute("data-traps", "1");
    await user.click(screen.getByTestId("guide-do-rest"));
    expect(screen.getByTestId("budget-meter")).toHaveTextContent("20 of 20 segments placed");
    // Every step done: "now scout why" opens in full.
    expect(screen.getByTestId("guide-steps-done")).toBeInTheDocument();
    expect(screen.getByTestId("guide-why")).toHaveTextContent("The 2 raiders from the north meet a fence with one way through, position 3");
    // Honest: no promise of a hold.
    expect(guide).toHaveTextContent("does not guarantee a hold");
    expect(guide.textContent).not.toMatch(/\b(base|camp)\b/i);
  });
});

describe("after the first trip (chunk 24)", () => {
  it("an overrun is said plainly, then the passive side; with no one left in the roster nothing is saved", async () => {
    const party = expectShape(partyShape, partyJson.body).party;
    const saveParty = vi.fn(async () => ({ party }));
    const advance = vi.fn(async (step: OnboardingStep) => ({ onboarding: onboardingBody(step), changed: true }));
    const api = fakeApi({
      onboarding: vi.fn(async () => ({ onboarding: onboardingBody("bank") })),
      advanceOnboarding: advance,
      me: async () => meWith([]),
      tripStatus: vi.fn(async () => statusOverrun()),
      party: vi.fn(async () => ({ party: { ...party, config: { ...party.config, units: [] }, roster: [] } })),
      saveParty,
    });
    render(
      <OnboardingProvider api={api}>
        <ShellGuide api={api} route="trail" />
      </OnboardingProvider>,
    );
    const card = await screen.findByTestId("guide-party");
    expect(advance).toHaveBeenCalledWith("party");
    // QA S3: the card leads with what happened to the player's own caravan, under its own heading;
    // the passive side follows under a heading that says whose party meets whose caravan.
    await waitFor(() => expect(within(card).getAllByRole("heading")[0]).toHaveTextContent("Your caravan was overrun"));
    expect(within(card).getAllByRole("heading").map((h) => h.textContent)).toEqual(["Your caravan was overrun", "Meanwhile, your own party meets other players' caravans"]);
    expect(card).not.toHaveTextContent("Whose parties you just fought");
    expect(card).toHaveTextContent("never at risk");
    // QA S2: what the ended trip recorded, not "what you packed is lost".
    const losses = within(card).getByTestId("guide-overrun-losses");
    expect(losses).toHaveTextContent("Lost outright (still standing when the caravan fell): Dust Rider · Level 1, Dust Rider · Level 1.");
    expect(losses).toHaveTextContent("Fell in the fighting and come home a level lower (never below level 1): Dust Rider · Level 1.");
    expect(losses).toHaveTextContent("No unbanked Coin was lost");
    expect(card).not.toHaveTextContent("what you packed is lost");
    // An encounter-1 overrun: no stake choice was made, so none is claimed.
    expect(card).not.toHaveTextContent("itemized before");
    expect(card).toHaveTextContent("The party you just faced was an authored outfit");
    await userEvent.setup().click(within(card).getByTestId("guide-raise-party"));
    await screen.findByTestId("guide-party-empty");
    expect(saveParty).not.toHaveBeenCalled();
  });

  it("QA S2: an overrun where nothing was still standing says so, and a later overrun names the push", async () => {
    const base = statusOverrun();
    const ending = { ...(base.trip!.ending as Extract<NonNullable<NonNullable<typeof base.trip>["ending"]>, { kind: "overrun" }>), encounterIndex: 2, unitsLostOutright: [], coinLost: 1000 };
    const status = { ...base, trip: { ...base.trip!, ending } };
    const api = fakeApi({
      onboarding: vi.fn(async () => ({ onboarding: onboardingBody("party") })),
      advanceOnboarding: vi.fn(async (step: OnboardingStep) => ({ onboarding: onboardingBody(step), changed: true })),
      me: async () => meWith([]),
      tripStatus: vi.fn(async () => status),
    });
    render(
      <OnboardingProvider api={api}>
        <ShellGuide api={api} route="town" />
      </OnboardingProvider>,
    );
    const losses = await screen.findByTestId("guide-overrun-losses");
    expect(losses).toHaveTextContent("Lost outright: none.");
    expect(losses).toHaveTextContent("Unbanked Coin lost: 1000.");
    expect(screen.getByTestId("guide-party")).toHaveTextContent("itemized before you chose to push");
  });

  it("QA N5: a voided first trip gets its own card, not 'the parties you just faced'", async () => {
    const base = statusVoided();
    const ending = { ...(base.trip!.ending as Extract<NonNullable<NonNullable<typeof base.trip>["ending"]>, { kind: "voided" }>), voidedEncounter: 1, encountersSurvived: 0 };
    const api = fakeApi({
      onboarding: vi.fn(async () => ({ onboarding: onboardingBody("party") })),
      advanceOnboarding: vi.fn(async (step: OnboardingStep) => ({ onboarding: onboardingBody(step), changed: true })),
      me: async () => meWith([]),
      tripStatus: vi.fn(async () => ({ ...base, trip: { ...base.trip!, ending } })),
    });
    render(
      <OnboardingProvider api={api}>
        <ShellGuide api={api} route="town" />
      </OnboardingProvider>,
    );
    const card = await screen.findByTestId("guide-voided");
    expect(card).toHaveTextContent("Encounter 1 could not be resolved");
    expect(card).toHaveTextContent("nothing was credited and nothing was lost");
    const party = screen.getByTestId("guide-party");
    expect(within(party).getAllByRole("heading")[0]).toHaveTextContent("Your first trip could not be resolved");
    expect(party).not.toHaveTextContent("The parties you just faced");
  });

  it("a banked trip raises the party from the roster through the ordinary save", async () => {
    const party = expectShape(partyShape, partyJson.body).party;
    const empty = { ...party, config: { ...party.config, units: [] } };
    const saveParty = vi.fn(async (config: unknown) => ({ party: { ...party, config: config as typeof party.config } }));
    const onSaved = vi.fn();
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    const api = fakeApi({
      onboarding: vi.fn(async () => ({ onboarding: onboardingBody("party") })),
      advanceOnboarding: vi.fn(async (step: OnboardingStep) => ({ onboarding: onboardingBody(step), changed: true })),
      me: async () => meWith([]),
      tripStatus: vi.fn(async () => statusBanked()),
      party: vi.fn(async () => ({ party: empty })),
      saveParty,
    });
    render(
      <OnboardingProvider api={api}>
        <ShellGuide api={api} route="trail" onPartySaved={onSaved} />
      </OnboardingProvider>,
    );
    const card = await screen.findByTestId("guide-party");
    expect(card).not.toHaveTextContent("overrun");
    await userEvent.setup().click(within(card).getByTestId("guide-raise-party"));
    await screen.findByTestId("guide-party-raised");
    expect(saveParty).toHaveBeenCalledTimes(1);
    expect((saveParty.mock.calls[0]![0] as { units: { ref: string }[] }).units.map((u) => u.ref)).toEqual(raiseOrder(party.roster.filter((r) => r.unlocked)).map((r) => r.instanceId).slice(0, Math.min(party.caps.units, TUNABLES.SUGGESTED_PARTY_MAX))); // BALANCE-LOG pass 8: round-robin over types
    expect(onSaved).toHaveBeenCalled();
    expect(window.location.hash).toBe("#/party");
    // QA N8: the Party screen opens at its top.
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

describe("the bank-or-push card (chunk 24 QA D2)", () => {
  it("reads the server's stakes: a 74/1100 survivor gets 'bank', with why; never 'this first trip pushes once'", async () => {
    const hurt = previewAfter1();
    const preview = { ...hurt, units: hurt.units.map((u, i) => (i === 0 ? { ...u, hp: 74, maxHp: 1100 } : u)) };
    const api = fakeApi({ tripPreview: vi.fn(async () => preview) });
    const { ResultGuide } = await import("./TrailGuide.tsx");
    const enc = statusDecide().trip!.encounters[0]!;
    render(<ResultGuide encounter={enc} deciding api={api} caravanId={CARAVAN_ID} />);
    const advice = await screen.findByTestId("guide-advice");
    expect(advice).toHaveAttribute("data-advice", "bank");
    expect(advice).toHaveTextContent("is at 74 of 1100 HP");
    expect(advice).toHaveTextContent("suggests banking");
    expect(screen.getByTestId("guide-result")).not.toHaveTextContent("pushes once");
  });

  it("a circle in fair shape gets a suggestion to push once, with the risk named — a suggestion, not an order", async () => {
    const api = fakeApi({ tripPreview: vi.fn(async () => previewAfter1()) });
    const { ResultGuide } = await import("./TrailGuide.tsx");
    render(<ResultGuide encounter={statusDecide().trip!.encounters[0]!} deciding api={api} caravanId={CARAVAN_ID} />);
    const advice = await screen.findByTestId("guide-advice");
    expect(advice).toHaveAttribute("data-advice", "push");
    expect(advice).toHaveTextContent("Your call");
    expect(advice).toHaveTextContent("Pushing risks");
  });
});

describe("the guide on the Trail (chunk 24)", () => {
  function guideApi(start: OnboardingStep, over: Partial<Api>) {
    let step = start;
    const advance = vi.fn(async (want: OnboardingStep) => {
      const changed = stepRank(want) > stepRank(step);
      if (changed) step = want;
      return { onboarding: onboardingBody(step), changed };
    });
    const api = fakeApi({ onboarding: vi.fn(async () => ({ onboarding: onboardingBody(step) })), advanceOnboarding: advance, me: async () => meWith([]), ...over });
    return { api, advance, step: () => step };
  }

  it("encounter 1, before searching: the search card, and the account's guide moves to 'scout'", async () => {
    const g = guideApi("outfit", {
      tripStatus: vi.fn(async () => statusArranging(1)),
      candidates: vi.fn(async () => {
        throw new ApiError(404, "no_search", "not yet");
      }),
    });
    render(
      <OnboardingProvider api={g.api}>
        <TrailScreen api={g.api} />
      </OnboardingProvider>,
    );
    await screen.findByTestId("guide-search");
    await waitFor(() => expect(g.advance).toHaveBeenCalledWith("scout"));
    expect(g.step()).toBe("scout");
  });

  it("a decided encounter 1 shows the server's outcome and the bank-or-push card; a finished guide shows nothing", async () => {
    const g = guideApi("arrange", { tripStatus: vi.fn(async () => statusDecide()) });
    const { unmount } = render(
      <OnboardingProvider api={g.api}>
        <TrailScreen api={g.api} />
      </OnboardingProvider>,
    );
    const card = await screen.findByTestId("guide-result");
    expect(card).toHaveTextContent("Your caravan held");
    expect(within(screen.getByTestId("encounter-result-1")).getByTestId("result-outcome")).toHaveTextContent("The caravan held.");
    await waitFor(() => expect(g.step()).toBe("result"));
    expect(card).not.toHaveTextContent("pushes once");
    unmount();

    const done = guideApi("done", { tripStatus: vi.fn(async () => statusDecide()) });
    render(
      <OnboardingProvider api={done.api}>
        <TrailScreen api={done.api} />
      </OnboardingProvider>,
    );
    await screen.findByTestId("encounter-result-1");
    expect(screen.queryByTestId("guide-result")).toBeNull();
    expect(done.advance).not.toHaveBeenCalled();
  });
});
