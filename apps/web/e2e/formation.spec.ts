/**
 * Formation e2e (chunk 08): signs in as a run-unique seeded account (scripts/e2e.mjs seeds
 * it and passes E2E_FORMATION_USERNAME), packs a manifest through the API (packing in
 * town is chunk 17), opens the Trail tab, reads the scouting panel, places a fence and a
 * post BY DRAG on the real PixiJS canvas, sets a stance, and commits a deliberately
 * gapped circle. Also checks the lattice is invisible when nothing is being dragged.
 *
 * Portrait phone viewport (playwright.config.ts). Pointer gestures are driven through
 * page.mouse, which Chromium turns into the pointer events the screen listens for.
 */
import { expect, test, type Page } from "@playwright/test";

const USERNAME = process.env["E2E_FORMATION_USERNAME"] ?? "dev";
const PASSWORD = process.env["E2E_FORMATION_PASSWORD"] ?? "devpassword";

async function cellToClient(page: Page, cell: { x: number; y: number }): Promise<{ x: number; y: number }> {
  // The canvas publishes nothing global; compute through the same pure projection the app
  // uses by reading the camera back from the canvas' own geometry: drop a probe via the
  // tap-to-place path instead would need the cell; so we ask the page's module directly.
  const p = await page.evaluate(({ x, y }) => (window as unknown as { __isoDebug?: { cellToClient(c: { x: number; y: number }): { x: number; y: number } | null } }).__isoDebug?.cellToClient({ x, y }), cell);
  if (!p) throw new Error("iso debug hook missing");
  return p;
}

async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // A few intermediate moves: the drag starts after an 8px move, and the ghost needs a move over the canvas.
  await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test("scout, drag a fence and a post onto the circle, set a stance, commit a gapped formation", async ({ page, request }) => {
  // Sign in through the API to pack the manifest (trip start is a town action, chunk 17).
  const login = await request.post("/api/auth/login", { data: { username: USERNAME, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token } = (await login.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  const me = (await (await request.get("/api/me", { headers: auth })).json()) as { caravans: { id: string; units: { id: string; unit_type_id: string }[] }[] };
  const caravan = me.caravans[0]!;
  const riders = caravan.units.filter((u) => u.unit_type_id === "desert.dust_rider").map((u) => u.id);
  expect(riders.length).toBeGreaterThanOrEqual(2);
  const pack = await request.post(`/api/caravans/${caravan.id}/manifest`, {
    headers: auth,
    data: { units: riders.slice(0, 2), traps: ["trap.spike_pit"], fence: { tierId: "fence.brush_pile", count: 20 } },
  });
  expect(pack.status(), await pack.text()).toBe(201);

  await page.goto("/");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await page.getByRole("button", { name: "Trail" }).click();

  const screen = page.getByTestId("formation-screen");
  await expect(screen).toBeVisible();
  await expect(page.getByRole("heading", { name: "Encounter 1" })).toBeVisible();

  // The scouting report is complete before anything is placed: units, stances, edges, siege.
  const scout = page.getByTestId("scout-panel");
  await expect(scout).toContainText("3 units");
  await expect(scout).toContainText("1 siege piece");
  await expect(scout).toContainText("Beelines for the core");
  await expect(scout).toContainText("Enters from the north at (");
  await expect(scout).toContainText("Counters timber fences");
  await expect(scout.locator(".statpair")).toHaveCount(3);

  // The canvas rendered (WebGL) and the lattice is hidden while nothing is dragged.
  const canvas = page.getByTestId("iso-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.locator(".iso__unavailable")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __isoDebug?: { latticeAlpha(): number } }).__isoDebug?.latticeAlpha())).toBe(0);

  // Manifest tray reflects the pack: 20 segments in the wagon, 1 trap, 2 riders at full HP.
  await expect(page.getByTestId("fence-tray-line")).toContainText("20 in the wagon · 0 on the ring · 0 destroyed · 20 packed");
  await expect(page.getByTestId("tray-trap-t0")).toContainText("Fires once");

  // Drag the next fence segment onto ring position 0 (north side, cell (12, 11)). The map is
  // sticky, so the chip is scrolled into view first and the target measured after the scroll.
  const fenceChip = page.getByTestId("tray-fence-next").getByRole("button");
  await fenceChip.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const fenceBox = (await fenceChip.boundingBox())!;
  const ring1 = await cellToClient(page, { x: 12, y: 11 });
  await dragTo(page, { x: fenceBox.x + 40, y: fenceBox.y + fenceBox.height / 2 }, ring1);
  await expect(page.getByTestId("budget-meter")).toContainText("1 of 20 segments placed · 28 ring positions");
  await expect(page.getByTestId("gaps-line")).toContainText("27 open positions");

  // Drag a rider to (13, 13), inside the ring; the stance picker appears; choose Hold.
  const riderChip = page.getByTestId(`tray-unit-${riders[0]}`).getByRole("button");
  await riderChip.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const riderBox = (await riderChip.boundingBox())!;
  const post = await cellToClient(page, { x: 13, y: 13 });
  await dragTo(page, { x: riderBox.x + 40, y: riderBox.y + 20 }, post);
  await expect(page.getByTestId(`tray-unit-${riders[0]}`)).toContainText("Posted at (13, 13)");
  await page.getByRole("radio", { name: "Hold" }).click();
  await expect(page.getByRole("radio", { name: "Hold" })).toHaveAttribute("aria-checked", "true");

  // Post the second rider by tap-to-place, so every living unit has a post.
  await page.getByTestId(`tray-unit-${riders[1]}`).getByRole("button").click();
  const post2 = await cellToClient(page, { x: 18, y: 18 });
  await page.mouse.click(post2.x, post2.y);
  await expect(page.getByTestId(`tray-unit-${riders[1]}`)).toContainText("Posted at (18, 18)");

  // Lattice hidden again after the drags.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __isoDebug?: { latticeAlpha(): number } }).__isoDebug?.latticeAlpha())).toBe(0);

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
  await expect(dialog).toContainText("hold");
  await page.getByTestId("commit-confirm").click();
  await expect(page.getByTestId("committed-notice")).toBeVisible();
  await expect(screen).toHaveAttribute("data-committed", "true");

  // The server agrees: the formation for encounter 1 is committed with those contents.
  const stored = (await (await request.get(`/api/caravans/${caravan.id}/encounters/1/formation`, { headers: auth })).json()) as {
    formation: { committedAt: string | null; gaps: number[]; formation: { fences: unknown[]; posts: { stance: string }[] } };
  };
  expect(stored.formation.committedAt).not.toBeNull();
  expect(stored.formation.gaps).toHaveLength(27);
  expect(stored.formation.formation.fences).toHaveLength(1);
  expect(stored.formation.formation.posts.map((p) => p.stance).sort()).toEqual(["guard", "hold"]);

  // Reloading the tab shows the committed, locked state.
  await page.reload();
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Trail" }).click();
  await expect(page.getByTestId("committed-notice")).toBeVisible();
  await expect(page.getByTestId("commit-open")).toHaveCount(0);
});
