import { TUNABLES } from "@caravan/content";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.ts";
import type { ManifestView } from "../../api/types.ts";
import { CARAVAN_ID, economyView, fakeApi, uid, unlocksWith } from "../../test/townFixtures.ts";
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
    ...over,
  });
}

describe("OutfitScreen", () => {
  it("meters the roster against DEPLOYMENT_SLOT_CAP and warns past it; traps and fence against theirs", async () => {
    const user = userEvent.setup();
    render(<OutfitScreen api={api()} caravanId={CARAVAN_ID} units={units} onBack={() => {}} onPacked={() => {}} />);
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

  it("ride out: a real-modal confirm, then exactly the chosen manifest is packed → 'Packed, waiting to ride out.'", async () => {
    const user = userEvent.setup();
    const packManifest = vi.fn(async () => ({ manifest: packedManifest() }));
    const onPacked = vi.fn();
    render(<OutfitScreen api={api({ packManifest })} caravanId={CARAVAN_ID} units={units} onBack={() => {}} onPacked={onPacked} />);
    await screen.findByTestId("outfit-screen");
    await user.click(within(screen.getByTestId("outfit-units")).getAllByRole("checkbox")[0]!);
    await user.click(within(screen.getByTestId("outfit-traps")).getByRole("button", { name: "Add Spike Pit" }));
    await user.selectOptions(screen.getByTestId("outfit-fence-tier"), "fence.brush_pile");
    await user.click(screen.getByTestId("outfit-ride-out"));
    const dialog = screen.getByRole("dialog", { name: "Pack the caravan with this manifest?" });
    expect(dialog).toHaveTextContent("1 living unit");
    expect(dialog).toHaveTextContent("1 trap");
    expect(dialog).toHaveTextContent(`${TUNABLES.FENCE_MATERIAL_BUDGET} segments of Brush Pile`);
    expect(packManifest).not.toHaveBeenCalled();
    await user.click(within(dialog).getByTestId("outfit-confirm"));
    expect(packManifest).toHaveBeenCalledWith(CARAVAN_ID, { units: [uid(1)], traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: TUNABLES.FENCE_MATERIAL_BUDGET } });
    expect(await screen.findByTestId("outfit-packed")).toHaveTextContent("Packed, waiting to ride out.");
    expect(screen.getByTestId("packed-summary")).toHaveTextContent("1 unit · 1 trap · 20 fence segments");
    expect(onPacked).toHaveBeenCalled();
  });

  it("the server's issue list is shown exactly when it refuses", async () => {
    const user = userEvent.setup();
    const packManifest = vi.fn(async () => {
      throw new ApiError(400, "manifest_empty", "a manifest must pack at least one living unit", undefined, [{ code: "manifest_empty", message: "pack at least one living unit" }]);
    });
    render(<OutfitScreen api={api({ packManifest })} caravanId={CARAVAN_ID} units={units} onBack={() => {}} onPacked={() => {}} />);
    await screen.findByTestId("outfit-screen");
    await user.click(screen.getByTestId("outfit-ride-out"));
    expect(screen.getByRole("dialog")).toHaveTextContent("the server will refuse it");
    await user.click(screen.getByTestId("outfit-confirm"));
    const issues = await screen.findByTestId("outfit-issues");
    expect(issues).toHaveTextContent("pack at least one living unit");
    expect(issues.textContent).not.toContain("manifest_empty");
  });
});
