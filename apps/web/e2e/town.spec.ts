/**
 * Town e2e (chunk 17): a fresh account (registered through the real API, granted Coin the
 * way Coin arrives — a `coin_earned` ledger event, inserted directly) walks the home town
 * end to end on a portrait phone viewport:
 *
 *   sign in → claim a refugee → recruit a second copy of the same type → DRAG one onto the
 *   other on the real PixiJS canvas → the merge preview quotes cost and balance → confirm →
 *   set up the standing party (add the merged unit, a stance, DRAG it onto the east entry
 *   band, save) → outfit the caravan (unit, trap, fence) → ride out → "Packed, waiting to
 *   ride out." The server's own views are checked after each write.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

const DATABASE_URL = process.env["E2E_DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const GRANT = 5_000;

type IsoDebug = { cellToClient(c: { x: number; y: number }): { x: number; y: number } | null; latticeAlpha(): number };

async function cellToClient(page: Page, cell: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((c) => (window as unknown as { __isoDebug?: IsoDebug }).__isoDebug?.cellToClient(c), cell);
  if (!p) throw new Error("iso debug hook missing");
  return p;
}

const latticeAlpha = (page: Page): Promise<number | undefined> => page.evaluate(() => (window as unknown as { __isoDebug?: IsoDebug }).__isoDebug?.latticeAlpha());

async function dragCell(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.getByTestId("iso-canvas").scrollIntoViewIfNeeded();
  const a = await cellToClient(page, from);
  const b = await cellToClient(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 10, a.y + 10, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 8 });
  expect(await latticeAlpha(page)).toBeGreaterThan(0);
  await page.mouse.up();
}

async function registerAndFund(request: APIRequestContext): Promise<{ username: string; password: string; token: string }> {
  const username = `e2e_town_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const password = "e2e-password-1";
  const res = await request.post("/api/auth/register", { data: { username, password, region: "desert", caravanName: "Town Caravan" } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { token: string; account: { id: string } };
  if (!DATABASE_URL) throw new Error("town e2e needs E2E_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL) to grant Coin");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload)
       VALUES ('coin_earned', $1, NULL, $2, 0, $3::jsonb)`,
      [body.account.id, `e2e:grant:coin:${body.account.id}`, JSON.stringify({ amount: GRANT, reason: "e2e" })],
    );
  } finally {
    await client.end();
  }
  return { username, password, token: body.token };
}

/** Portrait 360×640 (the smallest target): no horizontal scroll, every visible button at least 44px tall. */
async function fitsPortrait(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    // PixiJS's own off-screen accessibility hook is not a control the player sees.
    const small = [...document.querySelectorAll("button")].filter((b) => !b.title.startsWith("select to enable accessibility")).filter((b) => {
      const rect = b.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.height < 43.5;
    }).map((b) => `${b.textContent ?? ""} (${Math.round(b.getBoundingClientRect().height)}px)`);
    return { scroll: doc.scrollWidth, width: window.innerWidth, small };
  });
  expect(r.scroll).toBeLessThanOrEqual(r.width);
  expect(r.small).toEqual([]);
}

const cellOf = (text: string | null): { x: number; y: number } => {
  const m = /\((\d+), (\d+)\)/.exec(text ?? "");
  if (!m) throw new Error(`no cell in "${text}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
};

test("claim a refugee, merge by drag with confirm, set up the party, outfit and pack", async ({ page, request }) => {
  const fresh = await registerAndFund(request);
  const auth = { Authorization: `Bearer ${fresh.token}` };

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  await page.getByLabel("Username").fill(fresh.username);
  await page.getByLabel("Password").fill(fresh.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const town = page.getByTestId("town-screen");
  await expect(town).toBeVisible();
  await expect(page.getByTestId("caravan-state")).toHaveAttribute("data-state", "in_town");
  await expect(page.getByTestId("board-count")).toContainText("0 of 36 board slots used");
  await expect(page.getByTestId("mine-balance")).toContainText(/\d+ of 50000 Coin stored/);
  // At rest the lattice is invisible: the town reads as a place, not a board.
  expect(await latticeAlpha(page)).toBe(0);
  await fitsPortrait(page);

  // ── refugee: take the first offer ──
  const firstOffer = page.getByTestId("refugee-offers").getByRole("button", { name: /^Take / }).first();
  const takeLabel = (await firstOffer.textContent())!.trim();
  const typeName = takeLabel.replace(/^Take /, "");
  await firstOffer.click();
  await expect(page.getByTestId("refugee-panel").getByRole("status")).toHaveText(`Taken: ${typeName} joined the roster at level 1.`);
  await expect(page.getByTestId("board-count")).toContainText("1 of 36 board slots used");

  // ── recruit a second copy of that type: cost shown, then confirmed ──
  await page.getByTestId("recruit-list").getByRole("button", { name: `Recruit ${typeName} for 600 Coin` }).click();
  const recruitDialog = page.getByRole("dialog", { name: "Recruit a mercenary?" });
  await expect(recruitDialog).toContainText(`Spend 600 of`);
  await recruitDialog.getByRole("button", { name: "Spend Coin" }).click();
  await expect(page.getByTestId("recruit-panel").getByRole("status")).toContainText(`Recruited ${typeName} at level 1.`);
  await expect(page.getByTestId("board-count")).toContainText("2 of 36 board slots used");

  // ── merge: drag one onto the other on the real canvas → preview → confirm ──
  const chips = page.getByTestId("board-units").locator("li");
  await expect(chips).toHaveCount(2);
  const a = cellOf(await chips.nth(0).locator(".chip__sub").textContent());
  const b = cellOf(await chips.nth(1).locator(".chip__sub").textContent());
  await dragCell(page, a, b);
  expect(await latticeAlpha(page)).toBeLessThanOrEqual(0.38);
  const merge = page.getByRole("dialog", { name: "Merge preview" });
  await expect(merge.getByTestId("merge-cost")).toHaveText("Cost: 250 Coin (250 per resulting unit)");
  await expect(merge.getByTestId("merge-balance")).toContainText(/Balance: \d+ Coin, including \d+ trickled in/);
  await expect(merge.getByTestId("merge-slots")).toContainText("2 slots become 1: frees 1");
  await expect(merge).toContainText("not stronger than the consumed ones combined");
  await merge.getByTestId("merge-confirm").click();
  await expect(page.getByTestId("town-status")).toContainText(`Merged: 1 × ${typeName} level 2.`);
  await expect(page.getByTestId("board-count")).toContainText("1 of 36 board slots used");
  await expect(page.getByTestId("board-units")).toContainText(`${typeName} · L2`);
  // The lattice fades out after the drop.
  await expect.poll(() => latticeAlpha(page)).toBe(0);
  const me = (await (await request.get("/api/me", { headers: auth })).json()) as { caravans: { units: { merge_level: number }[] }[] };
  expect(me.caravans[0]!.units.map((u) => u.merge_level)).toEqual([2]);

  // ── the standing party: add the merged unit, a stance, drag it onto the east band, save ──
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Party" }).click();
  await expect(page.getByTestId("party-screen")).toBeVisible();
  await page.getByTestId("party-roster").getByRole("button", { name: new RegExp(`^Add ${typeName} L2`) }).click();
  const member = page.getByTestId("party-members").locator("li").first();
  await member.getByRole("button", { name: "Traps first" }).click();
  const start = cellOf(await member.getByTestId("member-line").textContent());
  await dragCell(page, start, { x: 31, y: 10 });
  await expect(member.getByTestId("member-line")).toHaveText("Enters from the East at (31, 10)");
  await page.getByTestId("party-save").click();
  await expect(page.getByTestId("party-screen").getByRole("status")).toHaveText("Party saved.");
  await expect(page.getByTestId("party-valid")).toBeVisible();
  await fitsPortrait(page);
  const party = (await (await request.get("/api/me/party", { headers: auth })).json()) as { party: { valid: boolean; config: { units: { stance: string; edge: string; cell: { x: number; y: number } }[] } } };
  expect(party.party.valid).toBe(true);
  expect(party.party.config.units).toEqual([expect.objectContaining({ stance: "traps", edge: "east", cell: { x: 31, y: 10 } })]);

  // ── outfit the caravan and pack ──
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Town" }).click();
  await page.getByTestId("nav-outfit").click();
  await expect(page.getByTestId("outfit-screen")).toBeVisible();
  await page.getByTestId("outfit-units").getByRole("checkbox").first().check();
  await expect(page.getByTestId("outfit-units-meter")).toHaveText("1 of 8 deployment slots");
  await page.getByTestId("outfit-traps").getByRole("button", { name: "Add Spike Pit" }).click();
  await page.getByTestId("outfit-fence-tier").selectOption("fence.brush_pile");
  await expect(page.getByTestId("outfit-fence-meter")).toContainText("20 of 20 segments");
  await expect(page.getByTestId("outfit-forecast")).toContainText("Your store has room for");
  await fitsPortrait(page);
  await page.getByTestId("outfit-ride-out").click();
  const ride = page.getByRole("dialog", { name: "Ride out with this manifest?" });
  await expect(ride).toContainText("1 living unit");
  await ride.getByTestId("outfit-confirm").click();
  await expect(page.getByTestId("outfit-packed")).toContainText("Packed, waiting to ride out.");
  await expect(page.getByTestId("packed-summary")).toHaveText("1 unit · 1 trap · 20 fence segments");
  await page.getByTestId("outfit-back").click();
  await expect(page.getByTestId("caravan-state")).toHaveAttribute("data-state", "packed");
  await expect(page.getByTestId("caravan-state")).toContainText("Packed, waiting to ride out.");
  const manifest = await request.get(`/api/caravans/${encodeURIComponent((await (await request.get("/api/me", { headers: auth })).json()).caravans[0].id)}/manifest`, { headers: auth });
  expect(manifest.status()).toBe(200);
});
