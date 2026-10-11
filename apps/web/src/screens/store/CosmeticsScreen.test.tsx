import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import { cosmeticsView } from "../../test/storeFixtures.ts";
import { fakeApi } from "../../test/townFixtures.ts";
import { CosmeticsScreen } from "./CosmeticsScreen.tsx";

const FENCE = "fence_style.weathered_grey";
const RED = "fence_style.painted_red";
const SKIN = "skin.desert.dust_rider.sunbleached";

describe("CosmeticsScreen", () => {
  it("says plainly that cosmetics are purely visual and never change a unit", async () => {
    render(<CosmeticsScreen api={fakeApi({ cosmetics: vi.fn(async () => cosmeticsView()) })} />);
    const note = await screen.findByTestId("cosmetics-visual-only");
    expect(note).toHaveTextContent("Cosmetics are purely visual");
    expect(note).toHaveTextContent("never a unit: not a stat, not a hitbox, not what a scout can read, not how a fight resolves");
    expect(screen.getByTestId("cosmetics-none")).toHaveTextContent("They come only from packs.");
  });

  it("lists owned cosmetics by kind and slot, and equips then unequips through the server", async () => {
    let equipped: Record<string, string> = {};
    const cosmetics = vi.fn(async () => cosmeticsView([FENCE, RED, SKIN], equipped));
    const equipCosmetic = vi.fn(async (id: string) => {
      equipped = { ...equipped, fence_style: id };
      return { slot: "fence_style", cosmeticId: id, equipped };
    });
    const unequipCosmetic = vi.fn(async (slot: string) => {
      const { [slot]: _gone, ...rest } = equipped;
      equipped = rest;
      return { slot, cleared: true, equipped };
    });
    render(<CosmeticsScreen api={fakeApi({ cosmetics, equipCosmetic, unequipCosmetic })} />);

    const fences = await screen.findByTestId("kind-fence_style");
    expect(fences).toHaveTextContent("Fence style (2)");
    expect(screen.getByTestId("kind-unit_skin")).toHaveTextContent("Unit skin (1)");
    expect(screen.getByTestId("slot-unit_skin:desert.dust_rider")).toHaveTextContent("Slot: Unit skin for your Dust Rider units");
    expect(screen.getByTestId("slot-fence_style-state")).toHaveTextContent("Nothing equipped: the default look.");

    await userEvent.click(screen.getByTestId(`equip-${FENCE}`));
    expect(equipCosmetic).toHaveBeenCalledWith(FENCE);
    expect(await screen.findByTestId("cosmetics-status")).toHaveTextContent("Weathered Grey equipped.");
    await waitFor(() => expect(screen.getByTestId("slot-fence_style-state")).toHaveTextContent("Equipped: Weathered Grey"));
    expect(screen.getByTestId("slot-fence_style")).toHaveAttribute("data-equipped", FENCE);

    // One per slot: equipping the other fence style replaces it.
    await userEvent.click(screen.getByTestId(`equip-${RED}`));
    await waitFor(() => expect(screen.getByTestId("slot-fence_style-state")).toHaveTextContent("Equipped: Barn Red"));
    expect(screen.getByTestId(`equip-${FENCE}`)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId(`unequip-${RED}`));
    expect(unequipCosmetic).toHaveBeenCalledWith("fence_style");
    await waitFor(() => expect(screen.getByTestId("slot-fence_style-state")).toHaveTextContent("Nothing equipped"));
    expect(screen.getByTestId("cosmetics-status")).toHaveTextContent("Barn Red unequipped");
    // Every write is followed by a re-read: the screen shows the server's equip map.
    expect(cosmetics).toHaveBeenCalledTimes(4);
  });

  it("shows a server refusal verbatim, the cosmetic's id replaced by its name, and re-reads", async () => {
    const cosmetics = vi.fn(async () => cosmeticsView([FENCE]));
    const equipCosmetic = vi.fn(async () => {
      throw new ApiError(409, "not_owned", `cosmetic '${FENCE}' is not owned by this account`);
    });
    render(<CosmeticsScreen api={fakeApi({ cosmetics, equipCosmetic })} />);
    await userEvent.click(await screen.findByTestId(`equip-${FENCE}`));
    const err = await screen.findByTestId("api-error");
    expect(err).toHaveTextContent("The server refused this.");
    expect(within(err).getByTestId("api-error-message")).toHaveTextContent("cosmetic Weathered Grey is not owned by this account");
    expect(err).toHaveTextContent("409 not_owned");
    await waitFor(() => expect(cosmetics).toHaveBeenCalledTimes(2));
  });

  it("shows an unknown-cosmetic refusal with the server's own words", async () => {
    const equipCosmetic = vi.fn(async () => {
      throw new ApiError(404, "unknown_cosmetic", "no cosmetic 'retired.thing'");
    });
    render(<CosmeticsScreen api={fakeApi({ cosmetics: vi.fn(async () => cosmeticsView([FENCE])), equipCosmetic })} />);
    await userEvent.click(await screen.findByTestId(`equip-${FENCE}`));
    expect(await screen.findByTestId("api-error-message")).toHaveTextContent("no cosmetic 'retired.thing'");
    expect(screen.getByTestId("api-error")).toHaveTextContent("404 unknown_cosmetic");
  });

  it("lists the catalog with when each cosmetic is next on offer", async () => {
    render(<CosmeticsScreen api={fakeApi({ cosmetics: vi.fn(async () => cosmeticsView([FENCE])) })} />);
    const catalog = await screen.findByTestId("cosmetics-catalog");
    expect(catalog.querySelector(`[data-cosmetic="${FENCE}"]`)).toHaveTextContent("Owned");
    expect(catalog.querySelector(`[data-cosmetic="${RED}"]`)).toHaveTextContent("Next on offer: week 41, Pack 2");
  });
});
