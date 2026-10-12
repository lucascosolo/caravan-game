/**
 * Town e2e (chunk 17): a fresh account (registered through the real API, granted Coin the
 * way Coin arrives — a `coin_earned` ledger event, inserted directly) walks the home town
 * end to end on a portrait phone viewport:
 *
 *   sign in → claim a refugee → recruit a second copy of the same type → DRAG one onto the
 *   other on the real PixiJS canvas → the merge preview quotes cost and balance → confirm →
 *   set up the standing party (add the merged unit, a stance, DRAG it onto the east entry
 *   band, save) → outfit the caravan (unit, trap, fence) → pack → "Packed, waiting to
 *   ride out." The server's own views are checked after each write.
 *
 * QA-17 additions: the town opens framed on the board with every cell ≥ 44 px wide (S1);
 * selecting a unit shows the lattice, deselecting hides it (S6); the 44 px check covers
 * inputs by their labels, selects and summaries too (S7); a packed unit cannot be merged
 * through the API (B1); the board layout is stored per account and sign-out clears it (D1).
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { TUNABLES, unlockWebFor } from "@caravan/content";

/** The starting roster every new caravan is granted (chunk 24 QA D1), read from content: its region's tier-0 living types × STARTING_ROSTER copies. */
function startingRosterSize(region: "desert" | "high_plains" | "mountain" | "badlands" = "desert"): number {
  return unlockWebFor("living", region).nodes.filter((n) => n.tier === 0).length * TUNABLES.STARTING_ROSTER.copiesPerStarterType;
}

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
  // Chunk 24: a fresh account starts the first-session guide; this spec is about something else, so it
  // reads the first screen's step and skips the rest through the real routes (onboarding.spec walks it).
  const headers = { Authorization: `Bearer ${body.token}` };
  expect((await request.post("/api/me/onboarding/advance", { headers, data: { step: "roster" } })).status()).toBe(200);
  expect((await request.post("/api/me/onboarding/skip", { headers })).status()).toBe(200);
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

/**
 * Portrait 360×640 (the smallest target): no horizontal scroll, every visible control at
 * least 44px tall — buttons, selects, summaries, links, and checkboxes / radios measured by
 * the label that carries them (the label is the touch target; QA-17 S7).
 */
async function fitsPortrait(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    // PixiJS's own off-screen accessibility hook is not a control the player sees.
    const controls = [...document.querySelectorAll<HTMLElement>("button, select, summary, a[href], input[type=checkbox], input[type=radio]")];
    const small = controls.filter((b) => !(b.title ?? "").startsWith("select to enable accessibility")).filter((b) => {
      const own = b.getBoundingClientRect();
      if (own.width === 0 || own.height === 0) return false;
      const target = b.tagName === "INPUT" ? (b.closest("label") ?? b).getBoundingClientRect() : own;
      return target.height < 43.5;
    }).map((b) => `${b.tagName}:${(b.textContent ?? "").trim().slice(0, 40)} (${Math.round((b.tagName === "INPUT" ? (b.closest("label") ?? b) : b).getBoundingClientRect().height)}px)`);
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
  // Every caravan starts with its starting roster (chunk 24 QA D1): the desert's starters × STARTING_ROSTER copies.
  const base = startingRosterSize();
  const slots = (n: number) => `${n} of ${TUNABLES.BOARD_SLOTS} board slots used`;
  await expect(page.getByTestId("board-count")).toContainText(slots(base));
  await expect(page.getByTestId("mine-balance")).toContainText(/\d+ of 50000 Coin stored/);
  // At rest the lattice is invisible: the town reads as a place, not a board.
  expect(await latticeAlpha(page)).toBe(0);
  await fitsPortrait(page);

  // ── QA-17 S1: opened framed on the 6×6 board (13..18), each cell's diamond ≥ 44 px wide ──
  await page.getByTestId("iso-canvas").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !!(window as unknown as { __isoDebug?: IsoDebug }).__isoDebug?.cellToClient({ x: 13, y: 13 }));
  const left = await cellToClient(page, { x: 13, y: 13 });
  const right = await cellToClient(page, { x: 14, y: 12 });
  expect(Math.abs(right.x - left.x)).toBeGreaterThanOrEqual(44);
  const box = (await page.getByTestId("iso-canvas").boundingBox())!;
  for (const c of [{ x: 13, y: 13 }, { x: 18, y: 13 }, { x: 18, y: 18 }, { x: 13, y: 18 }]) {
    const p = await cellToClient(page, c);
    expect(p.x).toBeGreaterThanOrEqual(box.x);
    expect(p.x).toBeLessThanOrEqual(box.x + box.width);
    expect(p.y).toBeGreaterThanOrEqual(box.y);
    expect(p.y).toBeLessThanOrEqual(box.y + box.height);
  }

  // ── refugee: take the first offer ──
  const firstOffer = page.getByTestId("refugee-offers").getByRole("button", { name: /^Take / }).first();
  const takeLabel = (await firstOffer.textContent())!.trim();
  const typeName = takeLabel.replace(/^Take /, "");
  await firstOffer.click();
  await expect(page.getByTestId("refugee-panel").getByRole("status")).toHaveText(`Taken: ${typeName} joined the roster at level 1.`);
  await expect(page.getByTestId("board-count")).toContainText(slots(base + 1));

  // ── recruit a second copy of that type: cost shown, then confirmed ──
  await page.getByTestId("recruit-list").getByRole("button", { name: `Recruit ${typeName} for 600 Coin` }).click();
  const recruitDialog = page.getByRole("dialog", { name: "Recruit a mercenary?" });
  await expect(recruitDialog).toContainText(`Spend 600 of`);
  await recruitDialog.getByRole("button", { name: "Spend Coin" }).click();
  await expect(page.getByTestId("recruit-panel").getByRole("status")).toContainText(`Recruited ${typeName} at level 1.`);
  await expect(page.getByTestId("board-count")).toContainText(slots(base + 2));

  // ── merge: drag one onto the other on the real canvas → preview → confirm ──
  // Two level-1 copies of the taken type (a starting-roster copy of it, if any, is just as good).
  const chips = page.getByTestId("board-units").locator("li").filter({ hasText: typeName });
  expect(await chips.count()).toBeGreaterThanOrEqual(2);
  const a = cellOf(await chips.nth(0).locator(".chip__sub").textContent());
  const b = cellOf(await chips.nth(1).locator(".chip__sub").textContent());

  // ── QA-17 S6: a tap selects a unit (tap-to-move counts as placing): the lattice shows; Done hides it ──
  await page.getByTestId("iso-canvas").scrollIntoViewIfNeeded();
  const tapAt = await cellToClient(page, a);
  await page.mouse.click(tapAt.x, tapAt.y);
  await expect(page.getByTestId("board-selection")).toBeVisible();
  await expect.poll(() => latticeAlpha(page)).toBeGreaterThan(0);
  await page.getByTestId("board-selection").getByRole("button", { name: "Done" }).click();
  await expect.poll(() => latticeAlpha(page)).toBe(0);

  await dragCell(page, a, b);
  expect(await latticeAlpha(page)).toBeLessThanOrEqual(0.38);
  const merge = page.getByRole("dialog", { name: "Merge preview" });
  await expect(merge.getByTestId("merge-cost")).toHaveText("Cost: 250 Coin (250 per resulting unit)");
  await expect(merge.getByTestId("merge-balance")).toHaveText(/^Balance: \d+ Coin(, including the trickle so far \(\d+\))?\.$/);
  await expect(merge.getByTestId("merge-slots")).toContainText("2 slots become 1: frees 1");
  await expect(merge).toContainText("not stronger than the consumed ones combined");
  await merge.getByTestId("merge-confirm").click();
  await expect(page.getByTestId("town-status")).toContainText(`Merged: 1 × ${typeName} level 2.`);
  await expect(page.getByTestId("board-count")).toContainText(slots(base + 1));
  await expect(page.getByTestId("board-units")).toContainText(`${typeName} · L2`);
  // The lattice fades out after the drop.
  await expect.poll(() => latticeAlpha(page)).toBe(0);
  const me = (await (await request.get("/api/me", { headers: auth })).json()) as { caravans: { units: { merge_level: number }[] }[] };
  expect(me.caravans[0]!.units.map((u) => u.merge_level).sort()).toEqual([...Array<number>(base).fill(1), 2]);

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
  const ride = page.getByRole("dialog", { name: "Pack the caravan and ride out?" });
  await expect(ride).toContainText("1 living unit");
  await expect(ride).toContainText("Riding out uses 1 of your 3 available trips (of 3).");
  await ride.getByTestId("outfit-confirm").click();
  // Chunk 23: packed AND ridden out — the Trail opens on the first encounter's search.
  await expect(page.getByTestId("trail-unsearched")).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Town" }).click();
  await expect(page.getByTestId("caravan-state")).toHaveAttribute("data-state", "on_trip");
  await expect(page.getByTestId("trip-cap")).toContainText("Trips available: 2 of 3.");
  const meNow = (await (await request.get("/api/me", { headers: auth })).json()) as { account: { id: string }; caravans: { id: string; units: { id: string }[] }[] };
  const caravanId = meNow.caravans[0]!.id;
  const manifest = await request.get(`/api/caravans/${encodeURIComponent(caravanId)}/manifest`, { headers: auth });
  expect(manifest.status()).toBe(200);
  const packedRef = ((await manifest.json()) as { manifest: { packed: { units: { ref: string }[] } } }).manifest.packed.units[0]!.ref;

  // ── QA-17 B1: the server refuses to merge a packed unit, whatever the caravan state says ──
  const extra = await request.post(`/api/me/caravans/${caravanId}/recruit`, { headers: auth, data: { unitTypeId: (await (await request.get(`/api/me/caravans/${caravanId}/recruit`, { headers: auth })).json()).recruitable[0].unitTypeId, requestId: crypto.randomUUID() } });
  expect(extra.status(), await extra.text()).toBe(201);
  const fresh2 = ((await extra.json()) as { acquired: { instanceId: string } }).acquired.instanceId;
  for (const path of ["merge/preview", "merge"]) {
    const refused = await request.post(`/api/me/caravans/${caravanId}/${path}`, { headers: auth, data: { instanceIds: [packedRef, fresh2] } });
    expect(refused.status()).toBe(409);
    // Chunk 23: the outfit now rides out right after packing, so the caravan is on a trip and the
    // state guard answers first; the state-independent `unit_packed` refusal (QA-17 B1) is pinned
    // server-side in test/economy.test.ts ("B1", both states).
    const body = (await refused.json()) as { error: string; packed?: string[] };
    expect(["caravan_on_trip", "unit_packed"]).toContain(body.error);
    if (body.error === "unit_packed") expect(body.packed).toEqual([packedRef]);
  }

  // ── QA-17 D1: the layout is kept per account + caravan, and signing out forgets it ──
  const keys = await page.evaluate(() => Object.keys(window.localStorage));
  expect(keys).toContain(`caravan.viewer.town.board.${meNow.account.id}.${caravanId}`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();
  expect((await page.evaluate(() => Object.keys(window.localStorage))).filter((k) => k.startsWith("caravan.viewer."))).toEqual([]);
});
