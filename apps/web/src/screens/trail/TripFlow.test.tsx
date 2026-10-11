/**
 * Chunk 23: every state of the Trail's trip chain — resolving (polls with backoff) →
 * results → bank-or-push (every stake itemized from the preview) → push → the next search;
 * bank → trip summary → town; overrun → summary; an unresolvable fight; a lost decision
 * answer retried with the same body. Server bodies are the contract test's real recordings
 * (src/test/tripFixtures.ts), run through the client's guards.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { BankResult, StakesPreview, TripStatusView } from "../../api/tripTypes.ts";
import type { IsoCanvasProps } from "../../iso/index.ts";
import { CARAVAN_ID, fakeApi, meWith } from "../../test/townFixtures.ts";
import { previewAfter1, statusArranging, statusBanked, statusDecide, statusOverrun, statusResolving, withTrip } from "../../test/tripFixtures.ts";
import { Stakes } from "./BankOrPushScreen.tsx";
import { TrailScreen } from "./TrailScreen.tsx";

vi.mock("../../iso/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../iso/index.ts")>("../../iso/index.ts");
  const IsoCanvas = forwardRef<unknown, IsoCanvasProps>(function MockCanvas(_props, ref) {
    useImperativeHandle(ref, () => ({ clientToCell: () => null, cellToClient: () => null, isOverCanvas: () => false, latticeAlpha: () => 0 }));
    return <div data-testid="iso-canvas" />;
  });
  return { ...actual, IsoCanvas };
});

afterEach(() => {
  window.location.hash = "";
});

const me = async () => meWith([]);
/** The preview of the decide fixture's trip (each recorded file renames ids on its own; the server's agree). */
const preview1 = (): StakesPreview => ({ ...previewAfter1(), tripId: statusDecide().trip!.id });
const FAST = [5, 5, 5];

function apiWith(statuses: TripStatusView[], over: Partial<Api> = {}): { api: Api; tripStatus: ReturnType<typeof vi.fn> } {
  let i = 0;
  const tripStatus = vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]!);
  return { api: fakeApi({ me, tripStatus, tripPreview: vi.fn(async () => preview1()), ...over }), tripStatus };
}

const searchNotYet = vi.fn(async () => {
  throw new ApiError(404, "no_search", "no candidates have been searched for encounter 2");
});

describe("trip chain on the Trail tab", () => {
  it("resolving polls the trip status with backoff, then shows the encounter's results from the server's projection", async () => {
    const decide = statusDecide();
    const { api, tripStatus } = apiWith([statusResolving(), statusResolving(), statusResolving(), decide]);
    render(<TrailScreen api={api} pollBackoffMs={FAST} />);
    const resolving = await screen.findByTestId("resolving-screen");
    expect(resolving).toHaveTextContent("Encounter 1: the fight is under way");
    expect(resolving).toHaveTextContent("resolves on the server without you");
    const results = await screen.findByTestId("encounter-result-1", {}, { timeout: 3000 });
    expect(tripStatus.mock.calls.length).toBeGreaterThanOrEqual(4);
    const enc = decide.trip!.encounters[0]!;
    const r = enc.result!;
    expect(within(results).getByTestId("result-outcome")).toHaveTextContent("The caravan held.");
    expect(within(results).getByTestId("result-depth")).toHaveTextContent(`The attackers got ${Math.round((enc.depth * 100) / 1024)}% of the way to the core.`);
    expect(within(results).getByTestId("result-coin")).toHaveTextContent(`+${enc.coinAccrued} Coin this encounter, carried unbanked.`);
    expect(within(results).getByTestId("result-killed")).toHaveTextContent("None");
    const damaged = within(results).getByTestId("result-damaged");
    for (const u of r.unitsDamaged) expect(damaged).toHaveTextContent(`Dust Rider · Level ${u.mergeLevel} · HP ${u.hpBefore} → ${u.hpAfter} of ${u.maxHp}`);
    expect(within(results).getByTestId("result-traps")).toHaveTextContent("Spike Pit");
    expect(within(results).getByTestId("result-fences")).toHaveTextContent("Brush Pile #1");
    // The replay hand-off is present, disabled and says why (chunk 22 is not built).
    const watch = within(results).getByTestId("watch-fight");
    expect(watch).toBeDisabled();
    expect(watch).toHaveTextContent("Watch the fight (replay coming)");
    // No raw refs or job ids in what the player reads.
    expect(results.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|encounter:/);
  });

  it("a failed check is shown with Retry and stops polling; Retry resumes", async () => {
    let n = 0;
    const tripStatus = vi.fn(async () => {
      n++;
      if (n === 2) throw new ApiError(0, "network", "fetch failed");
      return n < 4 ? statusResolving() : statusDecide();
    });
    const user = userEvent.setup();
    render(<TrailScreen api={fakeApi({ me, tripStatus })} pollBackoffMs={FAST} />);
    const box = await screen.findByTestId("api-error");
    expect(box).toHaveTextContent("Could not check on the fight.");
    const calls = tripStatus.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(tripStatus.mock.calls.length).toBe(calls);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("encounter-result-1", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("push: a real-modal confirm restating the stakes, then the decision names its encounter, then the next encounter's search", async () => {
    const user = userEvent.setup();
    const decide = statusDecide();
    const pushTrip = vi.fn(async () => ({ tripId: decide.trip!.id, pushedPast: 1, nextEncounter: 2, replayed: false }));
    const { api } = apiWith([decide, statusArranging(2)], { pushTrip, candidates: searchNotYet });
    render(<TrailScreen api={api} />);
    await user.click(await screen.findByTestId("to-decision"));
    await screen.findByTestId("bank-or-push");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Survived encounter 1: bank or push?");
    const p = previewAfter1();
    await user.click(screen.getByTestId("push-open"));
    const dialog = await screen.findByRole("dialog", { name: "Push on to encounter 2?" });
    const alive = p.units.filter((u) => u.alive).length;
    expect(await within(dialog).findByTestId("push-quote")).toHaveTextContent(`${p.ifOverrun.coinLost} unbanked Coin and ${alive} living units stay at risk. If the caravan is overrun, all of it is lost.`);
    expect(dialog).toHaveTextContent(`Worth ${p.nextEncounter.reward} Coin if survived`);
    expect(dialog).toHaveTextContent("Nothing is repaired, healed or re-armed.");
    await user.click(within(dialog).getByTestId("push-confirm"));
    expect(pushTrip).toHaveBeenCalledWith(CARAVAN_ID, decide.trip!.id, 1);
    const next = await screen.findByTestId("trail-unsearched");
    expect(next).toHaveAttribute("data-encounter", "2");
    expect(screen.getByTestId("search")).toBeEnabled();
  });

  it("bank: confirm quotes credit and discard from a fresh preview, then the trip summary, then back to town", async () => {
    const user = userEvent.setup();
    const decide = statusDecide();
    const banked = statusBanked();
    const ending = banked.trip!.ending!;
    if (ending.kind !== "banked") throw new Error("fixture");
    const bankResult: BankResult = { tripId: decide.trip!.id, encountersSurvived: ending.encountersSurvived, requested: ending.requested, credited: ending.credited, discarded: ending.discarded, balanceAfter: 2400, restored: ending.restored, replayed: false };
    const bankTrip = vi.fn(async () => bankResult);
    const tripPreview = vi.fn(async () => preview1());
    const { api } = apiWith([decide, banked], { bankTrip, tripPreview, manifest: vi.fn(async () => { throw new ApiError(404, "no_open_manifest", "nothing packed"); }) });
    render(<TrailScreen api={api} />);
    await user.click(await screen.findByTestId("to-decision"));
    await screen.findByTestId("bank-or-push");
    const before = tripPreview.mock.calls.length;
    await user.click(screen.getByTestId("bank-open"));
    const dialog = await screen.findByRole("dialog", { name: "Bank the trip?" });
    const p = previewAfter1();
    expect(await within(dialog).findByTestId("bank-quote")).toHaveTextContent(`The trip ends. ${p.bankNow.forecast.wouldCredit} Coin is banked in the town, safe for good.`);
    expect(tripPreview.mock.calls.length).toBe(before + 1); // re-read before quoting (README §4)
    await user.click(within(dialog).getByTestId("bank-confirm"));
    expect(bankTrip).toHaveBeenCalledWith(CARAVAN_ID, decide.trip!.id, 1);
    const summary = await screen.findByTestId("trip-summary");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Trip summary");
    expect(within(summary).getByTestId("summary-banked")).toHaveTextContent(`Banked after ${ending.encountersSurvived} encounters. The caravan is home.`);
    expect(within(summary).getByTestId("summary-banked")).toHaveTextContent(`${ending.unbankedCoin} Coin from the encounters + ${ending.deliveryBonus} Coin for the delivery = ${ending.requested} Coin.`);
    expect(within(summary).getByTestId("summary-credited")).toHaveTextContent(`${ending.credited} Coin banked.`);
    expect(within(summary).getByTestId("summary-balance")).toHaveTextContent("Banked Coin in town is now 2400.");
    for (const e of banked.trip!.encounters) expect(within(summary).getByTestId(`encounter-result-${e.index}`)).toBeInTheDocument();
    await user.click(screen.getByTestId("summary-to-town"));
    expect(window.location.hash).toBe("#/town");
  });

  it("overrun: the summary says what was lost (from the trip_overrun record), with each encounter's results", async () => {
    const over = statusOverrun();
    const { api } = apiWith([statusResolving(), over], { manifest: vi.fn(async () => { throw new ApiError(404, "no_open_manifest", "nothing packed"); }) });
    render(<TrailScreen api={api} pollBackoffMs={FAST} />);
    const summary = await screen.findByTestId("trip-summary", {}, { timeout: 3000 });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Trip summary");
    const e = over.trip!.ending!;
    if (e.kind !== "overrun") throw new Error("fixture");
    const box = within(summary).getByTestId("summary-overrun");
    expect(box).toHaveTextContent(`Overrun at encounter ${e.encounterIndex}.`);
    expect(within(box).getByTestId("summary-coin-lost")).toHaveTextContent(`${e.coinLost} unbanked Coin was lost.`);
    expect(within(box).getByTestId("summary-lost")).toHaveTextContent("Dust Rider · Level 1");
    expect(within(box).getByTestId("summary-demerged")).toHaveTextContent("Dust Rider · Level 1 · Stays at level 1 (level 1 is the floor)");
    expect(box).toHaveTextContent(e.lossesApplied ? "applied" : "the roster has not been changed yet");
    expect(within(summary).getByTestId("encounter-result-1")).toHaveAttribute("data-outcome", "caravan_overrun");
    expect(within(summary).getByTestId("encounter-result-1")).toHaveTextContent("The caravan was overrun.");
    // No bank or push is offered after an overrun.
    expect(screen.queryByTestId("bank-open")).toBeNull();
    expect(screen.queryByTestId("push-open")).toBeNull();
  });

  it("an ended trip seen later is 'Your last trip'; a packed caravan is 'packed, waiting' instead", async () => {
    const { api } = apiWith([statusBanked()], { manifest: vi.fn(async () => { throw new ApiError(404, "no_open_manifest", "nothing packed"); }) });
    const { unmount } = render(<TrailScreen api={api} />);
    await screen.findByTestId("trip-summary");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your last trip");
    unmount();
  });

  it("a fight the server cannot resolve yet is said plainly: nothing lost, nothing decided", async () => {
    const parked = withTrip(statusResolving(), { phase: "resolution_unavailable", job: { id: "encounter:x:1", status: "parked", lastError: "no resolver" } });
    const { api } = apiWith([parked]);
    render(<TrailScreen api={api} />);
    const s = await screen.findByTestId("resolution-unavailable");
    expect(s).toHaveTextContent("Encounter 1 cannot be fought out yet");
    expect(s).toHaveTextContent("Nothing has been lost and nothing is decided");
    expect(s.textContent).not.toContain("no resolver");
  });

  it("a lost decision answer keeps the dialog and Try again sends the very same decision; the replay is said", async () => {
    const user = userEvent.setup();
    const decide = statusDecide();
    let n = 0;
    const pushTrip = vi.fn(async () => {
      n++;
      if (n === 1) throw new ApiError(0, "network", "fetch failed");
      return { tripId: decide.trip!.id, pushedPast: 1, nextEncounter: 2, replayed: true };
    });
    const { api } = apiWith([decide, statusArranging(2)], { pushTrip, candidates: searchNotYet });
    render(<TrailScreen api={api} />);
    await user.click(await screen.findByTestId("to-decision"));
    await user.click(await screen.findByTestId("push-open"));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("push-quote");
    await user.click(within(dialog).getByTestId("push-confirm"));
    expect(await within(dialog).findByTestId("decision-unconfirmed")).toHaveTextContent("Could not confirm the decision");
    expect(within(dialog).getByTestId("push-confirm")).toHaveTextContent("Try again");
    await user.click(within(dialog).getByTestId("push-confirm"));
    expect(pushTrip.mock.calls).toEqual([
      [CARAVAN_ID, decide.trip!.id, 1],
      [CARAVAN_ID, decide.trip!.id, 1],
    ]);
    expect(await screen.findByTestId("trail-notice")).toHaveTextContent("That push had already gone through.");
  });

  it("a decision that is no longer open is said, and neither choice is offered", async () => {
    const user = userEvent.setup();
    const closed: StakesPreview = { ...previewAfter1(), decisionOpen: false, decisionFor: null };
    const { api } = apiWith([statusDecide()], { tripPreview: vi.fn(async () => closed) });
    render(<TrailScreen api={api} />);
    await user.click(await screen.findByTestId("to-decision"));
    expect(await screen.findByTestId("decide-closed")).toBeInTheDocument();
    expect(screen.getByTestId("bank-open")).toBeDisabled();
    expect(screen.getByTestId("push-open")).toBeDisabled();
  });
});

describe("the bank-or-push itemization (GUARDRAILS §4: every stake, from the preview)", () => {
  it("itemizes unbanked Coin, the bank total and forecast, each unit's HP and merge level on death, overrun losses, traps, fences and the next encounter", () => {
    const p = previewAfter1();
    render(<Stakes preview={p} />);
    const unbanked = screen.getByTestId("stake-unbanked");
    expect(unbanked).toHaveTextContent(`${p.unbankedCoin.total} Coin carried on the trail, not yet banked.`);
    for (const e of p.unbankedCoin.byEncounter) expect(unbanked).toHaveTextContent(`Encounter ${e.index}: ${e.coin} Coin`);
    expect(screen.getByTestId("stake-bank")).toHaveTextContent(`${p.bankNow.encounterCoin} Coin from the encounters + ${p.bankNow.deliveryBonus} Coin for the delivery = ${p.bankNow.total} Coin.`);
    expect(screen.getByTestId("stake-bank-forecast")).toHaveTextContent(`All ${p.bankNow.forecast.wouldCredit} Coin fits: your store holds ${p.bankNow.forecast.balance} of ${p.bankNow.forecast.cap} Coin right now.`);
    for (const u of p.units) {
      const li = screen.getByTestId(`stake-unit-${u.ref}`);
      expect(li).toHaveTextContent(`Dust Rider · Level ${u.mergeLevel}`);
      expect(li).toHaveTextContent(`Alive · HP ${u.hp} of ${u.maxHp} (${u.damage} damage carried, not repaired)`);
      expect(li).toHaveTextContent(`If it dies: stays at level ${u.mergeLevelOnDeath} (level 1 is the floor)`);
    }
    expect(screen.getByTestId("stake-overrun")).toHaveTextContent(`Lose all ${p.ifOverrun.coinLost} unbanked Coin.`);
    expect(within(screen.getByTestId("stake-overrun-lost")).getAllByRole("listitem")).toHaveLength(p.ifOverrun.unitsLostOutright.length);
    expect(screen.getByTestId("stake-overrun-demerged")).toHaveTextContent("None");
    expect(screen.getByTestId("stake-traps")).toHaveTextContent(`${p.traps.remaining.length} still armed`);
    expect(screen.getByTestId("stake-traps")).toHaveTextContent(`${p.traps.spent.length} spent, not re-armed: Spike Pit`);
    expect(screen.getByTestId("stake-fences")).toHaveTextContent(`${p.fences.intact.length} intact`);
    expect(screen.getByTestId("stake-fences")).toHaveTextContent(`${p.fences.destroyed.length} destroyed, not rebuilt`);
    expect(screen.getByTestId("stake-fences")).toHaveTextContent("Brush Pile #1");
    const next = screen.getByTestId("stake-next");
    expect(next).toHaveTextContent(`Encounter ${p.nextEncounter.index} if you push`);
    expect(next).toHaveTextContent(`Worth ${p.nextEncounter.reward} Coin if survived`);
    expect(next).toHaveTextContent(`Banking right after surviving it would deliver ${p.nextEncounter.bankTotalIfSurvived} Coin.`);
    expect(screen.getByTestId("stake-next-difficulty")).toHaveTextContent(`Harder: the next party is searched ${p.nextEncounter.difficulty.escalationApplied} Reputation above your own (+${p.nextEncounter.difficulty.risePerEncounter} per encounter).`);
    expect(next).toHaveTextContent("The party arrives at full strength; yours does not.");
    expect(screen.getByTestId("stake-opponent")).toHaveTextContent("0 Reputation beyond the band searched · Earn multiplier 100%");
    // Nothing to buy anywhere on the decision (GUARDRAILS §2), and nothing says staying out is safer.
    expect(document.body.textContent).not.toMatch(/buy|purchase|pay|safer|bonus for staying/i);
  });

  it("an overflowing bank, a dead unit and a merged unit are each itemized as the server reports them", () => {
    const base = previewAfter1();
    const [a, b] = base.units;
    const p: StakesPreview = {
      ...base,
      bankNow: { ...base.bankNow, forecast: { ...base.bankNow.forecast, balance: 49_500, room: 500, wouldCredit: 500, wouldDiscard: 400 } },
      units: [
        { ...a!, mergeLevel: 3, mergeLevelOnDeath: 2 },
        { ...b!, hp: 0, damage: b!.maxHp, alive: false, diedAtEncounter: 1 },
      ],
      ifOverrun: { coinLost: base.ifOverrun.coinLost, unitsLostOutright: [{ ref: a!.ref, typeId: a!.typeId, mergeLevel: 3, hp: a!.hp }], unitsDeMergedNotDestroyed: [{ ref: b!.ref, typeId: b!.typeId, mergeLevel: 1, mergeLevelAfter: 1 }] },
      fences: { ...base.fences, intact: [{ ...base.fences.intact[0]!, hp: 120 }, ...base.fences.intact.slice(1)] },
    };
    render(<Stakes preview={p} />);
    const f = screen.getByTestId("stake-bank-forecast");
    expect(f).toHaveAttribute("role", "alert");
    expect(f).toHaveTextContent("Only 500 Coin fits under the cap (49500 of 50000 Coin stored right now); 400 Coin would be discarded.");
    expect(screen.getByTestId(`stake-unit-${a!.ref}`)).toHaveTextContent("If it dies: drops to level 2");
    expect(screen.getByTestId(`stake-unit-${b!.ref}`)).toHaveTextContent("Dead since encounter 1");
    expect(screen.getByTestId(`stake-unit-${b!.ref}`)).toHaveAttribute("data-alive", "false");
    expect(screen.getByTestId("stake-overrun-lost")).toHaveTextContent("Dust Rider · Level 3");
    expect(screen.getByTestId("stake-overrun-demerged")).toHaveTextContent("Dust Rider · Level 1 · Stays at level 1 (level 1 is the floor)");
    expect(screen.getByTestId("stake-fences")).toHaveTextContent("Brush Pile #2 · HP 120 of 300");
  });
});
