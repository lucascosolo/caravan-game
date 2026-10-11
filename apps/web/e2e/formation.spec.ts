/**
 * Formation e2e (chunk 08, with chunk 14's matchmaking): signs in as a run-unique seeded
 * account that scripts/e2e.mjs has already packed and put on the trail, then on the Trail
 * tab: searches for parties → scouts the three candidates (every one in full) → sees the
 * free, time-gated reroll countdown → chooses one → places a fence and a post BY DRAG on
 * the real PixiJS canvas → sets a stance → commits a deliberately gapped circle → the
 * server agrees, and (chunk 23) the Trail moves on to the resolved encounter. Also checks the lattice is invisible when nothing is being dragged, and
 * that nothing on the screen offers a Coin reroll.
 *
 * Portrait phone viewport (playwright.config.ts). Pointer gestures are driven through
 * page.mouse, which Chromium turns into the pointer events the screen listens for.
 */
import { expect, test, type Page } from "@playwright/test";

const USERNAME = process.env["E2E_FORMATION_USERNAME"] ?? "dev";
const PASSWORD = process.env["E2E_FORMATION_PASSWORD"] ?? "devpassword";

type IsoDebug = { cellToClient(c: { x: number; y: number }): { x: number; y: number } | null; latticeAlpha(): number; zoom(): number; pixiAccessibility(): boolean };

async function cellToClient(page: Page, cell: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((c) => (window as unknown as { __isoDebug?: IsoDebug }).__isoDebug?.cellToClient(c), cell);
  if (!p) throw new Error("iso debug hook missing");
  return p;
}

function zoom(page: Page): Promise<number | undefined> {
  return page.evaluate(() => (window as unknown as { __isoDebug?: IsoDebug }).__isoDebug?.zoom());
}

function latticeAlpha(page: Page): Promise<number | undefined> {
  return page.evaluate(() => (window as unknown as { __isoDebug?: IsoDebug }).__isoDebug?.latticeAlpha());
}

async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // A few intermediate moves: the drag starts after an 8px move, and the ghost needs a move over the canvas.
  await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test("search, scout three candidates, choose, drag a fence and a post, set a stance, commit a gapped formation", async ({ page, request }) => {
  // The flow is long and the four specs share the machine: a generous budget, not a race.
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Trail" }).click();

  // ── matchmaking: search, three fully scoutable candidates, free time-gated reroll ──
  await page.getByTestId("search").click();
  const list = page.getByTestId("candidate-list");
  await expect(list).toBeVisible();
  await expect(page.getByTestId("caravan-band")).toContainText("Reputation (band");
  for (const i of [0, 1, 2]) {
    const card = page.getByTestId(`candidate-${i}`);
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: /^Face / })).toBeVisible();
    // The scouting report is open by default, above the "Face …" button (QA N1): units with
    // stance, edge and start cell, both ratings; siege with counters.
    await expect(card.locator("details")).toHaveAttribute("open", "");
    const scout = card.getByTestId(`scout-panel-${i}`);
    await expect(scout).toContainText(/\d+ units?/);
    await expect(scout.locator(".statpair").first()).toBeVisible();
    await expect(scout).toContainText(/Enters from the (north|east|south|west) at \(\d+, \d+\)/);
    await expect(scout).toContainText(/Targets the nearest enemy|Prioritizes traps|Beelines for the core/);
  }
  const reroll = page.getByTestId("reroll");
  await expect(reroll).toBeDisabled();
  await expect(reroll).toContainText(/Search again in \d+s \(free, time-gated\)/);
  // No Coin reroll, purchase or shortcut anywhere; the earn-multiplier line is a server fact and stays.
  // An authored party's flavour line is story copy, not an offer ("Rail Bull Gang … when the pay
  // stopped" made this flake on the draw), so it is left out of the scan.
  const offerText = await page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    for (const el of body.querySelectorAll('[data-testid^="candidate-flavor-"]')) el.remove();
    return body.textContent ?? "";
  });
  expect(offerText).not.toMatch(/(buy|purchase|pay|coin(?! earn))/i);

  // Choose the first candidate; the formation screen opens against it.
  const chosenName = (await page.getByTestId("candidate-0").locator(".card__name").first().textContent())!.trim();
  await page.getByTestId("choose-0").click();
  const screen = page.getByTestId("formation-screen");
  await expect(screen).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Encounter 1" })).toBeVisible();
  await expect(page.getByTestId("facing-line")).toContainText(`Facing ${chosenName}.`);

  // The scouting report is on the formation screen too, in full, before anything is placed.
  const scout = page.getByTestId("scout-panel");
  await expect(scout).toContainText(/\d+ units?/);
  await expect(scout).toContainText(/Enters from the (north|east|south|west) at \(/);
  expect(await scout.locator(".card--attacker").count()).toBeGreaterThan(0);

  // The canvas rendered (WebGL) and the lattice is hidden while nothing is dragged.
  await expect(page.getByTestId("iso-canvas")).toBeVisible();
  await expect(page.locator(".iso__unavailable")).toHaveCount(0);
  await expect.poll(() => latticeAlpha(page)).toBe(0);

  // Manifest tray reflects the pack: 20 segments in the wagon, 1 trap, 2 riders.
  await expect(page.getByTestId("fence-tray-line")).toContainText("20 in the wagon · 0 on the ring · 0 destroyed · 20 packed");
  await expect(page.getByTestId("tray-trap-t0")).toContainText("Fires once");
  const riderChips = page.locator('[data-testid^="tray-unit-"]');
  await expect(riderChips).toHaveCount(2);

  // Drag the next fence segment onto ring position 0 (north side, cell (12, 11)). The map is
  // sticky, so the chip is scrolled to the viewport centre first and the target measured after.
  const fenceChip = page.getByTestId("tray-fence-next").getByRole("button");
  await fenceChip.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const fenceBox = (await fenceChip.boundingBox())!;
  const ring0 = await cellToClient(page, { x: 12, y: 11 });
  await dragTo(page, { x: fenceBox.x + 40, y: fenceBox.y + fenceBox.height / 2 }, ring0);
  await expect(page.getByTestId("budget-meter")).toContainText("1 of 20 segments placed · 28 ring positions");
  await expect(page.getByTestId("gaps-line")).toContainText("27 open positions");

  // Drag a rider to (13, 13), inside the ring; the stance picker appears; choose Hold.
  const riderChip = riderChips.nth(0).getByRole("button");
  await riderChip.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const riderBox = (await riderChip.boundingBox())!;
  const post = await cellToClient(page, { x: 13, y: 13 });
  await dragTo(page, { x: riderBox.x + 40, y: riderBox.y + 20 }, post);
  await expect(riderChips.nth(0)).toContainText("Posted at (13, 13)");
  await page.getByRole("radio", { name: "Hold" }).click();
  await expect(page.getByRole("radio", { name: "Hold" })).toHaveAttribute("aria-checked", "true");

  // Post the second rider by tap-to-place, so every living unit has a post.
  await riderChips.nth(1).getByRole("button").click();
  const post2 = await cellToClient(page, { x: 18, y: 18 });
  await page.mouse.click(post2.x, post2.y);
  await expect(riderChips.nth(1)).toContainText("Posted at (18, 18)");

  // Lattice hidden again after the drags.
  await expect.poll(() => latticeAlpha(page)).toBe(0);

  // ── touch (chunk 08 QA B3 / B4), wheel (S12), tap-to-place lattice (D5), no PixiJS a11y overlay (N3) ──
  const cdp = await page.context().newCDPSession(page);
  type TP = { x: number; y: number; id: number };
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", pts: TP[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
  await page.evaluate(() => window.scrollTo(0, 0));
  // B3: a pinch whose first finger lands ON the posted rider zooms and moves nothing.
  const zoom0 = (await zoom(page))!;
  const onPost = await cellToClient(page, { x: 13, y: 13 });
  const b0 = { x: onPost.x + 50, y: onPost.y + 30 };
  await touch("touchStart", [{ ...onPost, id: 1 }]);
  await touch("touchMove", [{ x: onPost.x - 12, y: onPost.y - 4, id: 1 }]);
  await touch("touchStart", [{ x: onPost.x - 12, y: onPost.y - 4, id: 1 }, { ...b0, id: 2 }]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x: onPost.x - 12 - i * 5, y: onPost.y - 4 - i * 3, id: 1 }, { x: b0.x + i * 5, y: b0.y + i * 3, id: 2 }]);
  await touch("touchEnd", [{ x: b0.x + 40, y: b0.y + 24, id: 2 }]);
  await touch("touchEnd", []);
  await expect(riderChips.nth(0)).toContainText("Posted at (13, 13)");
  expect(await zoom(page)).not.toBe(zoom0);
  await expect.poll(() => latticeAlpha(page)).toBe(0);
  // B4: a vertical swipe over the tray scrolls; it never drags the fence chip onto the map.
  const swipeChip = page.getByTestId("tray-fence-next").getByRole("button");
  await swipeChip.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const sb = (await swipeChip.boundingBox())!;
  const s0 = { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2, id: 3 };
  await touch("touchStart", [s0]);
  for (let i = 1; i <= 12; i++) await touch("touchMove", [{ x: s0.x, y: s0.y - i * 25, id: 3 }]);
  await touch("touchEnd", []);
  await expect(page.getByTestId("budget-meter")).toContainText("1 of 20 segments placed");
  // S12: the wheel zooms the map and leaves the page where it was.
  await page.evaluate(() => window.scrollTo(0, 0));
  const canvasBox = (await page.getByTestId("iso-canvas").boundingBox())!;
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  const zoomBefore = await zoom(page);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await zoom(page)).not.toBe(zoomBefore);
  // D5: selecting a tray item for tap-to-place shows the lattice; deselecting hides it.
  const fenceAgain = page.getByTestId("tray-fence-next").getByRole("button");
  await fenceAgain.click();
  await expect.poll(() => latticeAlpha(page)).toBeGreaterThan(0);
  await fenceAgain.click();
  await expect.poll(() => latticeAlpha(page)).toBe(0);
  // N3: Tab never wakes PixiJS's own accessibility overlay (the DOM lists are the text alternative).
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => (window as unknown as { __isoDebug?: IsoDebug }).__isoDebug?.pixiAccessibility())).toBe(false);

  // Save the draft: the server accepts a formation with 27 gaps.
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await expect(page.getByTestId("server-issues")).toHaveCount(0);

  // Commit through the modal, which itemizes what is placed.
  await page.getByTestId("commit-open").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("1 fence segment on ring positions #0");
  await expect(dialog).toContainText("27 ring positions left open");
  await expect(dialog).toContainText("2 units posted");
  await expect(dialog).toContainText("Hold");
  await page.getByTestId("commit-confirm").click();
  // Chunk 23: the commit goes through the trip loop (frozen + queued); the Trail moves on to the
  // fight, which the e2e server resolves with chunk 15's test double (CARAVAN_TEST_RESOLVER).
  await expect(page.getByTestId("resolving-screen").or(page.getByTestId("encounter-results"))).toBeVisible({ timeout: 15_000 });

  // The server agrees: the chosen candidate stands and the committed formation has those contents.
  const login = await request.post("/api/auth/login", { data: { username: USERNAME, password: PASSWORD } });
  const { token } = (await login.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  const me = (await (await request.get("/api/me", { headers: auth })).json()) as { caravans: { id: string }[] };
  const caravanId = me.caravans[0]!.id;
  const menu = (await (await request.get(`/api/me/caravans/${caravanId}/encounters/1/candidates`, { headers: auth })).json()) as {
    menu: { chosen: { candidateId: string } | null; candidates: { candidateId: string; owner: { displayName: string } }[] };
  };
  expect(menu.menu.chosen).not.toBeNull();
  expect(menu.menu.candidates.find((c) => c.candidateId === menu.menu.chosen!.candidateId)!.owner.displayName).toBe(chosenName);
  const stored = (await (await request.get(`/api/caravans/${caravanId}/encounters/1/formation`, { headers: auth })).json()) as {
    formation: { committedAt: string | null; gaps: number[]; formation: { fences: unknown[]; posts: { stance: string }[] } };
  };
  expect(stored.formation.committedAt).not.toBeNull();
  expect(stored.formation.gaps).toHaveLength(27);
  expect(stored.formation.formation.fences).toHaveLength(1);
  expect(stored.formation.formation.posts.map((p) => p.stance).sort()).toEqual(["guard", "hold"]);

  // Reloading the tab lands on the resolved encounter, not on an editable circle.
  // Chunk 30: a reload stays signed in (the server's HttpOnly device cookie); no second sign-in.
  await page.reload();
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Trail" }).click();
  await expect(page.getByTestId("encounter-results")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("commit-open")).toHaveCount(0);
});
