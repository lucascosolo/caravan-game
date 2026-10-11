/**
 * Chunk 24's screens: the first screen comes before any tab for a new account and cannot be
 * skipped; the guide's cards move on from the SERVER's state; skip asks first; the guided
 * arrangement edits the circle through the formation screen's own model; a finished account
 * sees no guide. No storage of any kind is touched.
 */
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
import { statusArranging, statusBanked, statusDecide, statusOverrun, statusPacked, withTrip } from "../test/tripFixtures.ts";
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
function server(start: OnboardingStep, opts: { units?: () => number } = {}) {
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
    expect(setItem).not.toHaveBeenCalled();
  });

  it("moves from 'take a unit' to 'pack and ride out' only when the server's roster has one", async () => {
    let units = 0;
    const s = server("roster", { units: () => units });
    window.history.replaceState(null, "", "#/town");
    render(<App fetchImpl={s.fetch} />);
    await signIn();
    await screen.findByTestId("guide-roster");
    // Another tab change re-reads the server: still no unit, still this step.
    window.location.hash = "#/webs";
    await waitFor(() => expect(s.calls.filter((c) => c.path === "/me").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("guide-roster")).toBeInTheDocument();
    expect(s.step()).toBe("roster");
    units = 1; // the player took a refugee (the ordinary claim route; the guide grants nothing)
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
    expect(guide).toHaveTextContent("2 of the 3 raiders start on the North side");
    const user = userEvent.setup();
    expect(screen.getByTestId("guide-step-fence")).toHaveAttribute("data-done", "false");
    await user.click(screen.getByTestId("guide-do-fence"));
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
    expect(screen.getByTestId("guide-why")).toHaveTextContent("position 3");
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
    expect(card).toHaveTextContent("Your caravan was overrun");
    expect(card).toHaveTextContent("never at risk");
    expect(card).toHaveTextContent("While you were out, someone else's party met a caravan");
    await userEvent.setup().click(within(card).getByTestId("guide-raise-party"));
    await screen.findByTestId("guide-party-empty");
    expect(saveParty).not.toHaveBeenCalled();
  });

  it("a banked trip raises the party from the roster through the ordinary save", async () => {
    const party = expectShape(partyShape, partyJson.body).party;
    const empty = { ...party, config: { ...party.config, units: [] } };
    const saveParty = vi.fn(async (config: unknown) => ({ party: { ...party, config: config as typeof party.config } }));
    const onSaved = vi.fn();
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
    expect((saveParty.mock.calls[0]![0] as { units: { ref: string }[] }).units.map((u) => u.ref)).toEqual(party.roster.filter((r) => r.unlocked).map((r) => r.instanceId).slice(0, party.caps.units));
    expect(onSaved).toHaveBeenCalled();
    expect(window.location.hash).toBe("#/party");
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
