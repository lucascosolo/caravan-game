import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../api/client.ts";
import type { PurchaseRequest } from "../../api/types.ts";
import { cosmeticsView, purchaseResult, storeView, WEEK } from "../../test/storeFixtures.ts";
import { fakeApi } from "../../test/townFixtures.ts";
import { PacksScreen, ratioFromBp } from "./PacksScreen.tsx";

function api(over: Partial<Api> = {}): Api {
  return fakeApi({
    store: vi.fn(async () => storeView()),
    cosmetics: vi.fn(async () => cosmeticsView()),
    ...over,
  });
}

async function openTier(tier: number): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId(`buy-${tier}`));
  return screen.findByTestId("purchase-dialog");
}

describe("PacksScreen", () => {
  it("shows every tier's exact contents, price, Coin, forecast, the ceiling and the sandbox notice before any purchase", async () => {
    const purchasePack = vi.fn();
    render(<PacksScreen api={api({ purchasePack })} />);
    const banner = await screen.findByTestId("sandbox-banner");
    expect(banner).toHaveTextContent("SANDBOX: no real money moves");
    expect(banner).toHaveTextContent("charges nothing ($0)");

    const t1 = await screen.findByTestId("offer-1");
    expect(t1).toHaveTextContent("Pack 1 · $5");
    expect(within(t1).getByTestId("offer-1-contents")).toHaveTextContent("6000 Coin");
    expect(t1).toHaveTextContent("Weathered Grey");
    expect(t1).toHaveTextContent("Fence style for your fence segments");
    const t2 = screen.getByTestId("offer-2");
    expect(t2).toHaveTextContent("Pack 2 · $10");
    expect(t2).toHaveTextContent("14000 Coin");
    expect(t2).toHaveTextContent("Sunbleached Dust Rider");
    expect(t2).toHaveTextContent("Unit skin for your Dust Rider units");
    expect(t2).toHaveTextContent("Water Tower");
    const t3 = screen.getByTestId("offer-3");
    expect(t3).toHaveTextContent("Pack 3 · $25");
    expect(t3).toHaveTextContent("40000 Coin");
    for (const name of ["Circus Stripe", "Lone Star", "Calico Homesteader"]) expect(t3).toHaveTextContent(name);
    // Every entry of every tier's contents is listed: one coin line plus each cosmetic.
    expect(within(t3).getByTestId("offer-3-contents").querySelectorAll("li")).toHaveLength(4);

    // The combined weekly ceiling, stated as all three tiers together.
    const ceiling = screen.getByTestId("store-ceiling");
    expect(ceiling).toHaveTextContent("The most Coin anyone can buy in a week is 60000 Coin: all 3 packs combined, not any single one.");
    expect(ceiling).toHaveTextContent("1.5× the Coin an active player is estimated to earn free in a week (40000 Coin)");
    expect(ceiling).toHaveTextContent("Your store holds at most 50000 Coin");
    // Next week's preview, not purchasable.
    const next = screen.getByTestId("store-upcoming");
    expect(next).toHaveTextContent(`Week ${WEEK + 1}`);
    expect(next).toHaveTextContent("Whitetop Conestoga");
    expect(next).toHaveTextContent("Barn Red");
    expect(within(next).queryByRole("button")).toBeNull();
    // Nothing bought by just looking.
    expect(purchasePack).not.toHaveBeenCalled();
  });

  it("shows the overflow forecast for each tier and for all unpurchased tiers combined", async () => {
    render(<PacksScreen api={api({ store: vi.fn(async () => storeView({ balance: 20_000 })) })} />);
    const f1 = await screen.findByTestId("offer-1-overflow");
    expect(f1).toHaveAttribute("data-warn", "no");
    expect(f1).toHaveTextContent("Fits: All 6000 Coin would be stored.");
    const f3 = screen.getByTestId("offer-3-overflow");
    expect(f3).toHaveAttribute("data-warn", "yes");
    expect(f3).toHaveTextContent("Over the cap: 30000 Coin would be stored; 10000 Coin would be discarded at the cap.");
    expect(f3).toHaveTextContent("Your store has room for 30000 more Coin right now");
    const combined = screen.getByTestId("store-combined");
    expect(combined).toHaveTextContent("Packs 1, 2, 3: 60000 Coin in all.");
    expect(screen.getByTestId("combined-overflow")).toHaveTextContent("30000 Coin would be stored; 30000 Coin would be discarded at the cap.");
  });

  it("marks a bought tier and leaves only the rest in the combined forecast", async () => {
    render(<PacksScreen api={api({ store: vi.fn(async () => storeView({ purchased: [2] })) })} />);
    const t2 = await screen.findByTestId("offer-2");
    expect(t2).toHaveAttribute("data-purchased", "yes");
    expect(screen.getByTestId("offer-2-bought")).toHaveTextContent("Bought this week");
    expect(screen.queryByTestId("buy-2")).toBeNull();
    expect(screen.getByTestId("store-combined")).toHaveTextContent("Packs 1, 3: 46000 Coin in all.");
  });

  it("the confirm re-reads the store and quotes exactly what will be granted and the overflow, then sends tier, week and contentsHash", async () => {
    const store = vi.fn(async () => storeView());
    const purchasePack = vi.fn(async (_req: PurchaseRequest) => purchaseResult(storeView().offers[1]!));
    render(<PacksScreen api={api({ store, purchasePack })} />);
    const dialog = await openTier(2);
    expect(store).toHaveBeenCalledTimes(2);
    expect(dialog).toHaveTextContent("Buy Pack 2 for $10?");
    expect(dialog).toHaveTextContent("Sandbox: no real money moves. You will be charged $0.");
    const contents = within(dialog).getByTestId("confirm-contents");
    expect(contents).toHaveTextContent("14000 Coin");
    expect(contents).toHaveTextContent("Sunbleached Dust Rider");
    expect(contents).toHaveTextContent("Water Tower");
    expect(within(dialog).getByTestId("confirm-overflow")).toHaveTextContent("All 14000 Coin would be stored.");
    expect(purchasePack).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByTestId("purchase-confirm"));
    const hash = storeView().offers[1]!.contentsHash;
    expect(purchasePack).toHaveBeenCalledWith({ tier: 2, weekIndex: WEEK, contentsHash: hash });
    const status = await screen.findByTestId("store-status");
    expect(status).toHaveTextContent("Bought Pack 2 (sandbox, $0): 14000 Coin stored. You now hold 15000 Coin.");
    expect(status).toHaveTextContent("New cosmetics: Sunbleached Dust Rider, Water Tower.");
    expect(screen.queryByTestId("purchase-dialog")).toBeNull();
  });

  it("marks a rotated-back cosmetic the account already owns as not granted twice", async () => {
    render(<PacksScreen api={api({ cosmetics: vi.fn(async () => cosmeticsView(["town.water_tower"])) })} />);
    const dialog = await openTier(2);
    const item = within(dialog).getByTestId("confirm-contents").querySelector('[data-cosmetic="town.water_tower"]')!;
    expect(item).toHaveTextContent("Already yours (rotated back): not granted twice.");
  });

  it("409 offer_changed: nothing is bought, the store is re-read, and the NEW contents are shown before any retry", async () => {
    let changed = false;
    const store = vi.fn(async () => (changed ? storeView({ swap: { 3: ["wagon.conestoga_white", "banner.lone_star", "fence_style.painted_red"] } }) : storeView()));
    const purchasePack = vi.fn(async (req: PurchaseRequest) => {
      if (req.contentsHash === storeView().offers[2]!.contentsHash) {
        changed = true;
        throw new ApiError(409, "offer_changed", "the offer's contents changed since it was shown; re-read the store");
      }
      return purchaseResult(storeView({ swap: { 3: ["wagon.conestoga_white", "banner.lone_star", "fence_style.painted_red"] } }).offers[2]!);
    });
    render(<PacksScreen api={api({ store, purchasePack })} />);
    const dialog = await openTier(3);
    expect(dialog).toHaveTextContent("Circus Stripe");
    await userEvent.click(within(dialog).getByTestId("purchase-confirm"));

    const notice = await within(dialog).findByTestId("offer-changed");
    expect(notice).toHaveTextContent("This pack changed since you looked. Nothing was bought.");
    expect(notice).toHaveTextContent("the offer's contents changed since it was shown");
    expect(notice).toHaveTextContent("409 offer_changed");
    const contents = within(dialog).getByTestId("confirm-contents");
    expect(contents).toHaveTextContent("Whitetop Conestoga");
    expect(contents).toHaveTextContent("Barn Red");
    expect(contents).not.toHaveTextContent("Circus Stripe");
    // One attempt so far: the retry waits for the player to see the new contents and confirm again.
    expect(purchasePack).toHaveBeenCalledTimes(1);

    await userEvent.click(within(dialog).getByTestId("purchase-confirm"));
    const newHash = storeView({ swap: { 3: ["wagon.conestoga_white", "banner.lone_star", "fence_style.painted_red"] } }).offers[2]!.contentsHash;
    expect(purchasePack).toHaveBeenLastCalledWith({ tier: 3, weekIndex: WEEK, contentsHash: newHash });
    expect(await screen.findByTestId("store-status")).toHaveTextContent("Bought Pack 3");
  });

  it("200 replay is shown as already yours: nothing charged again, nothing moved", async () => {
    const purchasePack = vi.fn(async () => purchaseResult(storeView().offers[0]!, { replayed: true }));
    render(<PacksScreen api={api({ purchasePack })} />);
    const dialog = await openTier(1);
    await userEvent.click(within(dialog).getByTestId("purchase-confirm"));
    const status = await screen.findByTestId("store-status");
    expect(status).toHaveTextContent(/Already yours: you bought Pack 1 this week \(.+\)\. Nothing was charged again and nothing moved\./);
    expect(status).not.toHaveTextContent("New cosmetics");
  });

  it("a tier the re-read shows as already bought says already yours instead of opening a confirm", async () => {
    const store = vi.fn().mockResolvedValueOnce(storeView()).mockResolvedValue(storeView({ purchased: [1] }));
    render(<PacksScreen api={api({ store })} />);
    await userEvent.click(await screen.findByTestId("buy-1"));
    expect(await screen.findByTestId("store-status")).toHaveTextContent("Already yours: you bought Pack 1 this week");
    expect(screen.queryByTestId("purchase-dialog")).toBeNull();
  });

  it("a lost answer keeps the dialog and retries the SAME body; the server's replay then says already yours", async () => {
    const purchasePack = vi
      .fn<(req: PurchaseRequest) => Promise<ReturnType<typeof purchaseResult>>>()
      .mockRejectedValueOnce(new ApiError(0, "network", "Failed to fetch"))
      .mockResolvedValueOnce(purchaseResult(storeView().offers[0]!, { replayed: true }));
    render(<PacksScreen api={api({ purchasePack })} />);
    const dialog = await openTier(1);
    await userEvent.click(within(dialog).getByTestId("purchase-confirm"));
    expect(await within(dialog).findByTestId("spend-unconfirmed")).toHaveTextContent("Could not confirm whether this went through");
    const retry = within(dialog).getByTestId("purchase-confirm");
    expect(retry).toHaveTextContent("Try again");
    await userEvent.click(retry);
    expect(purchasePack).toHaveBeenCalledTimes(2);
    expect(purchasePack.mock.calls[1]![0]).toEqual(purchasePack.mock.calls[0]![0]);
    expect(await screen.findByTestId("store-status")).toHaveTextContent("Already yours");
  });

  it("closing a dialog whose answer was lost re-reads the store and says so", async () => {
    const store = vi.fn(async () => storeView());
    const purchasePack = vi.fn().mockRejectedValue(new ApiError(0, "network", "Failed to fetch"));
    render(<PacksScreen api={api({ store, purchasePack })} />);
    const dialog = await openTier(1);
    await userEvent.click(within(dialog).getByTestId("purchase-confirm"));
    await within(dialog).findByTestId("spend-unconfirmed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(store).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("store-status")).toHaveTextContent("could not be confirmed");
  });

  it("a load failure is shown with Retry, the sandbox notice still up", async () => {
    const store = vi.fn().mockRejectedValueOnce(new ApiError(0, "network", "x")).mockResolvedValue(storeView());
    render(<PacksScreen api={api({ store })} />);
    expect(await screen.findByTestId("api-error")).toHaveTextContent("Could not reach the server.");
    expect(screen.getByTestId("sandbox-banner")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("offer-1")).toBeInTheDocument();
  });

  it("formats the ratio from basis points with integer arithmetic", () => {
    expect(ratioFromBp(15_000)).toBe("1.5");
    expect(ratioFromBp(10_000)).toBe("1");
    expect(ratioFromBp(12_345)).toBe("1.23");
    expect(ratioFromBp(10_500)).toBe("1.05");
  });
});
