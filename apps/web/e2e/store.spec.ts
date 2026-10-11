/**
 * Packs e2e (chunk 20 web): a fresh account (registered through the real API: each tier is
 * once per account per week, so the run must not reuse one) on a portrait phone viewport:
 *
 *   sign in → Town → Packs → the sandbox notice, tier 1's exact contents and its forecast →
 *   Buy → the confirm quotes the same contents → confirm → "Bought Pack 1" → the server's
 *   own views agree (one settled sandbox purchase crediting 6000 Coin; the cosmetic owned) →
 *   Equip your cosmetics → equip it → the server's equip map names it → a repeat POST of the
 *   same tier is the 200 `{replayed: true}` (the component tests cover how it is shown).
 *
 * Every visible control is ≥ 44 px tall and nothing scrolls sideways at 360×640, on the Packs
 * screen, in the purchase dialog and on the Cosmetics screen.
 */
import { expect, test, type Page } from "@playwright/test";

async function fitsPortrait(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const controls = [...document.querySelectorAll<HTMLElement>("button, select, summary, a[href], input[type=checkbox], input[type=radio]")];
    const small = controls
      .filter((b) => !(b.title ?? "").startsWith("select to enable accessibility"))
      .filter((b) => {
        const box = b.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.height < 43.5;
      })
      .map((b) => `${b.tagName}:${(b.textContent ?? "").trim().slice(0, 40)} (${Math.round(b.getBoundingClientRect().height)}px)`);
    return { scroll: doc.scrollWidth, width: window.innerWidth, small };
  });
  expect(r.scroll).toBeLessThanOrEqual(r.width);
  expect(r.small).toEqual([]);
}

interface StoreBody {
  week: { index: number };
  offers: { tier: number; coin: number; contentsHash: string; cosmetics: { id: string; displayName: string; slot: string }[] }[];
}

test("open Packs, preview tier 1, buy it (sandbox), get the Coin and the cosmetic, equip it", async ({ page, request }) => {
  const username = `e2e_store_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const password = "e2e-password-1";
  const reg = await request.post("/api/auth/register", { data: { username, password, region: "desert", caravanName: "Store Caravan" } });
  expect(reg.status(), await reg.text()).toBe(201);
  const auth = { Authorization: `Bearer ${((await reg.json()) as { token: string }).token}` };
  const store = (await (await request.get("/api/me/store", { headers: auth })).json()) as StoreBody;
  const tier1 = store.offers.find((o) => o.tier === 1)!;
  const cosmetic = tier1.cosmetics[0]!;

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("town-screen")).toBeVisible();

  // ── Town → Packs ──
  await page.getByTestId("nav-packs").click();
  await expect(page).toHaveURL(/#\/packs$/);
  await expect(page.getByTestId("sandbox-banner")).toContainText("SANDBOX: no real money moves");
  const offer = page.getByTestId("offer-1");
  await expect(offer).toContainText("Pack 1 · $5");
  await expect(page.getByTestId("offer-1-contents")).toContainText(`${tier1.coin} Coin`);
  await expect(page.getByTestId("offer-1-contents")).toContainText(cosmetic.displayName);
  await expect(page.getByTestId("offer-1-overflow")).toContainText(`All ${tier1.coin} Coin would be stored.`);
  await expect(page.getByTestId("store-ceiling")).toContainText("all 3 packs combined");
  await expect(page.getByTestId("store-combined")).toBeVisible();
  await expect(page.getByTestId("store-upcoming")).toBeVisible();
  await fitsPortrait(page);

  // ── Buy → the confirm quotes exactly the contents ──
  await page.getByTestId("buy-1").click();
  const dialog = page.getByTestId("purchase-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Buy Pack 1 for $5?");
  await expect(dialog).toContainText("You will be charged $0.");
  await expect(dialog.getByTestId("confirm-contents")).toContainText(`${tier1.coin} Coin`);
  await expect(dialog.getByTestId("confirm-contents")).toContainText(cosmetic.displayName);
  await expect(dialog.getByTestId("confirm-overflow")).toBeVisible();
  await fitsPortrait(page);
  await dialog.getByTestId("purchase-confirm").click();
  await expect(dialog).toBeHidden();
  const status = page.getByTestId("store-status");
  await expect(status).toContainText(`Bought Pack 1 (sandbox, $0): ${tier1.coin} Coin stored`);
  await expect(status).toContainText(`New cosmetics: ${cosmetic.displayName}.`);
  await expect(page.getByTestId("offer-1")).toHaveAttribute("data-purchased", "yes");

  // The server agrees: one settled sandbox purchase, the Coin credited, the cosmetic owned.
  const purchases = (await (await request.get("/api/me/store/purchases", { headers: auth })).json()) as {
    purchases: { tier: number; backend: string; settled: boolean; coin: { credited: number } }[];
  };
  expect(purchases.purchases).toHaveLength(1);
  expect(purchases.purchases[0]).toMatchObject({ tier: 1, backend: "sandbox_stub", settled: true, coin: { credited: tier1.coin } });
  const economy = (await (await request.get("/api/me/economy", { headers: auth })).json()) as { balance: number };
  expect(economy.balance).toBeGreaterThanOrEqual(tier1.coin);
  const owned = (await (await request.get("/api/me/cosmetics", { headers: auth })).json()) as { owned: { id: string }[] };
  expect(owned.owned.map((o) => o.id)).toEqual([cosmetic.id]);

  // ── Equip it ──
  await status.getByRole("button", { name: "Equip your cosmetics" }).click();
  await expect(page).toHaveURL(/#\/cosmetics$/);
  await expect(page.getByTestId("cosmetics-visual-only")).toContainText("purely visual");
  await page.getByTestId(`equip-${cosmetic.id}`).click();
  await expect(page.getByTestId(`slot-${cosmetic.slot}-state`)).toContainText(`Equipped: ${cosmetic.displayName}`);
  await expect(page.getByTestId(`unequip-${cosmetic.id}`)).toBeVisible();
  await fitsPortrait(page);
  const after = (await (await request.get("/api/me/cosmetics", { headers: auth })).json()) as { equipped: Record<string, string> };
  expect(after.equipped).toEqual({ [cosmetic.slot]: cosmetic.id });

  // ── A repeat of the same tier this week is the 200 replay: nothing moves ──
  const again = await request.post("/api/me/store/purchase", { headers: auth, data: { tier: 1, weekIndex: store.week.index, contentsHash: tier1.contentsHash } });
  expect(again.status()).toBe(200);
  expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
});
