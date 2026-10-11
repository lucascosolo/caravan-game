/**
 * Smoke e2e (chunk 06): the built app boots, the seeded dev account signs in, and the
 * unlock webs render whole with costs. Needs a running server on a migrated, seeded
 * database (see playwright.config.ts).
 *
 * The spend test (QA-06 S8) registers a fresh account through the real API, grants it
 * unlock points the only way points ever arrive — an `unlock_points_granted` ledger event,
 * inserted directly (the projection trigger folds it into pool_progress) — and walks one
 * confirm → spend → re-fetch pass through the UI, then checks the server's own view. A
 * fresh account per run keeps the test repeatable against the same database.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";

const USERNAME = process.env["E2E_USERNAME"] ?? "dev";
const PASSWORD = process.env["E2E_PASSWORD"] ?? "devpassword";
/** The same fallback chain scripts/e2e.mjs uses for the server it starts. */
const DATABASE_URL = process.env["E2E_DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const GRANTED = 5;

async function signIn(page: import("@playwright/test").Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Caravan Vaults" })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByText(username, { exact: true })).toBeVisible();
}

test("logs in and shows the whole unlock web with exact costs per pool", async ({ page }) => {
  await signIn(page, USERNAME, PASSWORD);

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Webs" }).click();
  await expect(page.getByRole("heading", { name: "Unlock webs" })).toBeVisible();

  // Living web of the seeded desert caravan: a locked capstone is visible with its exact cost
  // (living curve: tier 4 = 14), and the reason comes from the server's `missing` list.
  const living = page.getByTestId("web-living");
  await expect(living).toContainText("Caravan-level, Desert only");
  const vaquero = living.getByRole("button", { name: /^Vaquero\b/ });
  await expect(vaquero).toBeVisible();
  await expect(vaquero).toContainText("14 pts");
  await expect(vaquero).toContainText("Locked");
  await expect(vaquero).toContainText("Needs Canteen Carrier first");
  await expect(living.getByRole("button", { name: /^Dust Rider\b/ })).toContainText("Reached");

  // Trap web: account-level, all ten nodes present; the tier-4 fence costs 10 on this curve.
  await page.getByRole("tab", { name: "Traps & fences" }).click();
  const trap = page.getByTestId("web-trap");
  await expect(trap).toContainText("Account-level");
  await expect(trap.getByRole("button", { name: /^Stacked Stone\b/ })).toContainText("10 pts");
  await expect(trap.getByRole("button", { name: /^Spike Pit\b/ })).toContainText("Free");
  await expect(trap.locator("[data-node-id]")).toHaveCount(10);

  // Siege web: its own curve — tier 2 costs 8 here, not the trap web's 3.
  await page.getByRole("tab", { name: "Siege" }).click();
  const siege = page.getByTestId("web-siege");
  await expect(siege.getByRole("button", { name: /^Fence Cutters\b/ })).toContainText("8 pts");
  await expect(siege.getByRole("button", { name: /^Blasting Crate\b/ })).toContainText("21 pts");

  // Tapping a locked node shows its stats and the access-not-instance copy; no unlock button.
  await page.getByRole("tab", { name: "Traps & fences" }).click();
  await trap.getByRole("button", { name: /^Stacked Stone\b/ }).click();
  const detail = page.getByTestId("node-detail");
  await expect(detail).toContainText("Segment HP");
  await expect(detail).toContainText("does not give you one");
  await expect(detail.getByRole("button", { name: /^Unlock access/ })).toHaveCount(0);
  // The sheet took focus on its heading (S4).
  await expect(detail.getByRole("heading", { level: 2, name: "Stacked Stone" })).toBeFocused();
});

async function registerFreshAccount(request: APIRequestContext): Promise<{ username: string; password: string; accountId: string; token: string }> {
  const username = `e2e_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const password = "e2e-password-1";
  const res = await request.post("/api/auth/register", { data: { username, password, region: "desert", caravanName: "E2E Caravan" } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { token: string; account: { id: string } };
  return { username, password, accountId: body.account.id, token: body.token };
}

/** Grants `points` to the account's trap pool the way the game does: one ledger event per rung. */
async function grantTrapPoints(accountId: string, points: number): Promise<void> {
  if (!DATABASE_URL) throw new Error("e2e spend test needs E2E_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL) to grant points");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, payload)
       VALUES ('unlock_points_granted', $1, NULL, $2, 0, $3::jsonb)`,
      [accountId, `e2e:grant:trap:${accountId}`, JSON.stringify({ pool: "trap", points, rung: 1 })],
    );
    const pp = await client.query<{ unlock_points_granted: number; unlock_points_spent: number }>(
      "SELECT unlock_points_granted, unlock_points_spent FROM pool_progress WHERE account_id = $1 AND pool = 'trap'",
      [accountId],
    );
    expect(pp.rows[0]).toEqual({ unlock_points_granted: points, unlock_points_spent: 0 });
  } finally {
    await client.end();
  }
}

test("one confirm → spend → re-fetch pass against the real server (S8)", async ({ page, request }) => {
  const fresh = await registerFreshAccount(request);
  await grantTrapPoints(fresh.accountId, GRANTED);

  await signIn(page, fresh.username, fresh.password);
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Webs" }).click();
  await page.getByRole("tab", { name: "Traps & fences" }).click();
  const trap = page.getByTestId("web-trap");
  await expect(trap.getByTestId("points-available")).toHaveText(String(GRANTED));
  const snare = trap.getByRole("button", { name: /^Tripwire Snare\b/ });
  await expect(snare).toContainText("1 pt");
  await expect(snare).toContainText("Affordable");

  // Open the sheet and tap Unlock: the confirm quotes the server's cost and balance, nothing sent yet.
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/me/unlocks/spend")) posts.push(r.postData() ?? "");
  });
  await snare.click();
  const detail = page.getByTestId("node-detail");
  await detail.getByRole("button", { name: "Unlock access to Tripwire Snare for 1 pt" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Spend 1 of ${GRANTED} unlock points for access to Tripwire Snare? Points are never refunded.`);
  await expect(dialog).not.toContainText("will remain");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(posts).toHaveLength(0);

  // Cancel sends nothing and gives focus back to the Unlock button (S1).
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toHaveLength(0);
  await expect(detail.getByRole("button", { name: "Unlock access to Tripwire Snare for 1 pt" })).toBeFocused();

  // Confirm: exactly one POST with the server's shape, then the re-fetched state is what shows.
  await detail.getByRole("button", { name: "Unlock access to Tripwire Snare for 1 pt" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Spend points" }).click();
  await expect(page.getByRole("status")).toContainText(`Access to Tripwire Snare unlocked. ${GRANTED - 1} unlock points remain.`);
  expect(posts).toEqual([JSON.stringify({ pool: "trap", nodeId: "trap.tripwire_snare" })]);
  await expect(snare).toContainText("Reached");
  await expect(trap.getByTestId("points-available")).toHaveText(String(GRANTED - 1));
  await expect(trap.getByTestId("points-spent")).toHaveText("1");
  await expect(detail.getByRole("button", { name: /^Unlock access/ })).toHaveCount(0);
  await expect(detail).toContainText("Deploy it from the wagon-circle editor");

  // The server agrees: its own view has the node reached and the points spent.
  const view = await request.get("/api/me/unlocks", { headers: { Authorization: `Bearer ${fresh.token}` } });
  expect(view.status()).toBe(200);
  const webs = ((await view.json()) as { webs: { pool: string; points: { spent: number; available: number }; nodes: { id: string; reached: boolean }[] }[] }).webs;
  const trapWeb = webs.find((w) => w.pool === "trap")!;
  expect(trapWeb.points).toMatchObject({ spent: 1, available: GRANTED - 1 });
  expect(trapWeb.nodes.find((n) => n.id === "trap.tripwire_snare")!.reached).toBe(true);
});
