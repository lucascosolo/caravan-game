import { TUNABLES } from "@caravan/content";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.ts";
import type { ManifestView } from "../../api/types.ts";
import { CARAVAN_ID, economyView, fakeApi, uid, unlocksWith } from "../../test/townFixtures.ts";
import { capRefused, statusPacked, statusResolving, withCap } from "../../test/tripFixtures.ts";
import type { RosterUnit } from "./board.ts";
import { OutfitScreen } from "./OutfitScreen.tsx";

const CAP = TUNABLES.DEPLOYMENT_SLOT_CAP;
const units: RosterUnit[] = Array.from({ length: CAP + 2 }, (_, i) => ({ id: uid(i + 1), typeId: i % 2 ? "desert.well_digger" : "desert.dust_rider", mergeLevel: 1 + (i % 3) }));

function packedManifest(): ManifestView {
  const body = {
    v: 1 as const,
    units: [{ ref: uid(1), typeId: "desert.dust_rider", mergeLevel: 1, maxHp: 400, hp: 400 }],
    traps: [{ ref: "t0", typeId: "trap.spike_pit", spent: false }],
    fences: Array.from({ length: 20 }, (_, i) => ({ ref: `f${i}`, tierId: "fence.brush_pile", maxHp: 100, hp: 100 })),
  };
  return { id: uid(500), caravanId: CARAVAN_ID, encountersResolved: 0, createdAt: "", closedAt: null, packed: body, survivors: body, summary: { unitsAlive: 1, unitsDead: 0, trapsUnspent: 1, trapsSpent: 0, fencesIntact: 20, fencesDestroyed: 0 }, formations: [] } as unknown as ManifestView;
}

function api(over = {}) {
  return fakeApi({
    unlocks: vi.fn(async () => unlocksWith(["trap.spike_pit", "fence.brush_pile"])),
    economy: vi.fn(async (earn?: number) =>
      economyView(earn ? { overflow: { prospectiveEarn: earn, wouldCredit: earn, wouldDiscard: 0, warn: false, message: `Your store has room for 48800 more Coin right now.` } } : {}),
    ),
    tripStatus: vi.fn(async () => statusPacked()),
    ...over,
  });
}

describe("OutfitScreen", () => {
  beforeEach(() => window.localStorage.clear());

  it("final play-test review r2 N5: the next outfit opens with the last trip's traps and fence, and one tap packs its units again (minus any lost)", async () => {
    const user = userEvent.setup();
    const packManifest = vi.fn(async () => ({ manifest: packedManifest() }));
    const startTrip = vi.fn(async () => ({ tripId: uid(900), manifestId: uid(500), cap: statusResolving().cap, status: statusResolving() }));
    const first = render(<OutfitScreen api={api({ packManifest, startTrip })} caravanId={CARAVAN_ID} units={units} onBack={() => {}} onPacked={() => {}} onRodeOut={() => {}} />);
    await screen.findByTestId("outfit-screen");
    expect(screen.queryByTestId("outfit-last")).toBeNull();
    const boxes = within(screen.getByTestId("outfit-units")).getAllByRole("checkbox");
    for (const b of boxes.slice(0, 3)) await user.click(b);
    for (let i = 0; i < 4; i++) await user.click(within(screen.getByTestId("outfit-traps")).getByRole("button", { name: "Add Spike Pit" }));
    await user.selectOptions(screen.getByTestId("outfit-fence-tier"), "fence.brush_pile");
    await user.click(screen.getByTestId("outfit-ride-out"));
    await user.click(await screen.findByTestId("outfit-confirm"));
    await vi.waitFor(() => expect(startTrip).toHaveBeenCalled());
    first.unmount();

    // Next trip: unit 1 was lost; traps and fence come back on their own, units on one tap.
    render(<OutfitScreen api={api()} caravanId={CARAVAN_ID} units={units.slice(1)} onBack={() => {}} onPacked={() => {}} onRodeOut={() => {}} />);
    await screen.findByTestId("outfit-screen");
    expect(screen.getByTestId("outfit-traps-meter")).toHaveTextContent(`4 of ${TUNABLES.TRAP_SLOT_CAP} trap slots`);
    expect(screen.getByTestId("outfit-fence-tier")).toHaveValue("fence.brush_pile");
    expect(screen.getByTestId("outfit-units-meter")).toHaveTextContent(`0 of ${CAP} deployment slots`);
    const again = screen.getByTestId("outfit-same-as-last");
    expect(again).toHaveTextContent("2 units, 4 traps, 20 fence segments");
    expect(screen.getByTestId("outfit-last")).toHaveTextContent("1 unit from last trip is no longer in the roster.");
    await user.click(again);
    expect(screen.getByTestId("outfit-units-meter")).toHaveTextContent(`2 of ${CAP} deployment slots`);
  });

  it("meters the roster against DEPLOYMENT_SLOT_CAP and warns past it; traps and fence against theirs", async () => {
    const user = userEvent.setup();
    render(<OutfitScreen api={api()} caravanId={CARAVAN_ID} units={units} onBack={() => {}} onPacked={() => {}} onRodeOut={() => {}} />);
    await screen.findByTestId("outfit-screen");
    expect(screen.getByTestId("outfit-units-meter")).toHaveTextContent(`0 of ${CAP} deployment slots`);
    const boxes = within(screen.getByTestId("outfit-units")).getAllByRole("checkbox");
    for (const b of boxes.slice(0, CAP + 1)) await user.click(b);
    expect(screen.getByTestId("outfit-units-meter")).toHaveAttribute("data-over", "true");
    expect(screen.getByTestId("outfit-units-over")).toHaveTextContent("1 too many");
    await user.click(boxes[0]!);
    expect(screen.queryByTestId("outfit-units-over")).toBeNull();
    // Traps: only unlocked types; one per click.
    const trap = within(screen.getByTestId("outfit-traps"));
    for (let i = 0; i <= TUNABLES.TRAP_SLOT_CAP; i++) await user.click(trap.getByRole("button", { name: "Add Spike Pit" }));
    expect(screen.getByTestId("outfit-traps-over")).toHaveTextContent("1 too many");
    await user.click(trap.getByRole("button", { name: "Remove Spike Pit" }));
    expect(screen.getByTestId("outfit-traps-meter")).toHaveTextContent(`${TUNABLES.TRAP_SLOT_CAP} of ${TUNABLES.TRAP_SLOT_CAP} trap slots`);
    // Fence: the full budget by default, which is below the ring, so gaps are forced.
    await user.selectOptions(screen.getByTestId("outfit-fence-tier"), "fence.brush_pile");
    expect(screen.getByTestId("outfit-fence-meter")).toHaveTextContent(`${TUNABLES.FENCE_MATERIAL_BUDGET} of ${TUNABLES.FENCE_MATERIAL_BUDGET} segments (the ring has 28 positions, so gaps are forced)`);
    // The Coin forecast is the server's message.
    expect(screen.getByTestId("outfit-forecast")).toHaveTextContent("Your store has room for 48800 more Coin right now.");
  });

  it("pack and ride out: a real-modal confirm quoting the trip cap, then exactly the chosen manifest is packed and the trip started (chunk 23)", async () => {
    const user = userEvent.setup();
    const packManifest = vi.fn(async () => ({ manifest: packedManifest() }));
    const startTrip = vi.fn(async () => ({ tripId: uid(900), manifestId: uid(500), cap: statusResolving().cap, status: statusResolving() }));
    const onPacked = vi.fn();
    const onRodeOut = vi.fn();
    render(<OutfitScreen api={api({ packManifest, startTrip })} caravanId={CARAVAN_ID} units={units} onBack={() => {}} onPacked={onPacked} onRodeOut={onRodeOut} />);
    await screen.findByTestId("outfit-screen");
    await user.click(within(screen.getByTestId("outfit-units")).getAllByRole("checkbox")[0]!);
    await user.click(within(screen.getByTestId("outfit-traps")).getByRole("button", { name: "Add Spike Pit" }));
    await user.selectOptions(screen.getByTestId("outfit-fence-tier"), "fence.brush_pile");
    expect(screen.getByTestId("trip-cap")).toHaveTextContent("Trips available: 3 of 3. Every trip is available.");
    await user.click(screen.getByTestId("outfit-ride-out"));
    const dialog = screen.getByRole("dialog", { name: "Pack the caravan and ride out?" });
    expect(dialog).toHaveTextContent("Riding out uses 1 of your 3 available trips (of 3).");
    expect(dialog).toHaveTextContent("1 living unit");
    expect(dialog).toHaveTextContent("1 trap");
    expect(dialog).toHaveTextContent(`${TUNABLES.FENCE_MATERIAL_BUDGET} segments of Brush Pile`);
    expect(packManifest).not.toHaveBeenCalled();
    await user.click(within(dialog).getByTestId("outfit-confirm"));
    expect(packManifest).toHaveBeenCalledWith(CARAVAN_ID, { units: [uid(1)], traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: TUNABLES.FENCE_MATERIAL_BUDGET } });
    await vi.waitFor(() => expect(onRodeOut).toHaveBeenCalledWith(false));
    expect(startTrip).toHaveBeenCalledWith(CARAVAN_ID);
    expect(packManifest.mock.invocationCallOrder[0]!).toBeLessThan(startTrip.mock.invocationCallOrder[0]!);
    expect(onPacked).toHaveBeenCalled();
  });

  it("final play-test review N9: no trip available: Pack and ride out waits (disabled, with the countdown); nothing is packed", async () => {
    const user = userEvent.setup();
    const packManifest = vi.fn(async () => ({ manifest: packedManifest() }));
    const exhausted = withCap(statusPacked(), { available: 0, nextRegenAtMs: statusPacked().nowMs + 1_200_000, fullAtMs: statusPacked().nowMs + 3_600_000 });
    const tripStatus = vi.fn(async () => exhausted);
    render(<OutfitScreen api={api({ packManifest, tripStatus })} caravanId={CARAVAN_ID} units={units} onBack={() => {}} onPacked={() => {}} onRodeOut={() => {}} />);
    await screen.findByTestId("outfit-screen");
    await user.click(within(screen.getByTestId("outfit-units")).getAllByRole("checkbox")[0]!);
    expect(screen.getByTestId("outfit-ride-out")).toBeDisabled();
    expect(screen.getByTestId("outfit-ride-out")).toHaveTextContent("Next trip in 20 min");
    expect(screen.getByTestId("outfit-no-trip")).toHaveTextContent("No trip is available right now. The next one returns in 20 min; pack then.");
    expect(packManifest).not.toHaveBeenCalled();
  });

  it("the trip runs out between the read and the confirm: packed, waiting to ride out, with the server's refusal, its countdown, and Ride out disabled until it returns", async () => {
    const user = userEvent.setup();
    const packManifest = vi.fn(async () => ({ manifest: packedManifest() }));
    const startTrip = vi.fn(async () => {
      throw capRefused();
    });
    const exhausted = withCap(statusPacked(), { available: 0, nextRegenAtMs: statusPacked().nowMs + 1_200_000, fullAtMs: statusPacked().nowMs + 3_600_000 });
    // The outfit read saw a trip available; the start is refused (another device used it meanwhile).
    let reads = 0;
    const tripStatus = vi.fn(async () => (reads++ === 0 ? statusPacked() : exhausted));
    const onRodeOut = vi.fn();
    render(<OutfitScreen api={api({ packManifest, startTrip, tripStatus })} caravanId={CARAVAN_ID} units={units} onBack={() => {}} onPacked={() => {}} onRodeOut={onRodeOut} />);
    await screen.findByTestId("outfit-screen");
    await user.click(within(screen.getByTestId("outfit-units")).getAllByRole("checkbox")[0]!);
    await user.click(screen.getByTestId("outfit-ride-out"));
    await user.click(screen.getByTestId("outfit-confirm"));
    expect(await screen.findByTestId("outfit-packed")).toHaveTextContent("Packed, waiting to ride out.");
    expect(screen.getByTestId("packed-summary")).toHaveTextContent("1 unit · 1 trap · 20 fence segments");
    expect(screen.getByTestId("ride-out-refused")).toHaveTextContent("No trip is available right now. The next one returns in 20 min");
    expect(screen.getByTestId("ride-out-open-confirm")).toBeDisabled();
    expect(onRodeOut).not.toHaveBeenCalled();
    // Nothing on the way offers to buy or speed up a trip.
    expect(document.body.textContent).not.toMatch(/buy|purchase|pay|speed up now/i);
  });

  it("the server's issue list is shown exactly when it refuses", async () => {
    const user = userEvent.setup();
    const packManifest = vi.fn(async () => {
      throw new ApiError(400, "manifest_empty", "a manifest must pack at least one living unit", undefined, [{ code: "manifest_empty", message: "pack at least one living unit" }]);
    });
    render(<OutfitScreen api={api({ packManifest })} caravanId={CARAVAN_ID} units={units} onBack={() => {}} onPacked={() => {}} onRodeOut={() => {}} />);
    await screen.findByTestId("outfit-screen");
    await user.click(screen.getByTestId("outfit-ride-out"));
    expect(screen.getByRole("dialog")).toHaveTextContent("the server will refuse it");
    await user.click(screen.getByTestId("outfit-confirm"));
    const issues = await screen.findByTestId("outfit-issues");
    expect(issues).toHaveTextContent("pack at least one living unit");
    expect(issues.textContent).not.toContain("manifest_empty");
  });
});
