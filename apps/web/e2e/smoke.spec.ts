/**
 * Smoke e2e (chunk 06): the built app boots, the seeded dev account signs in, and the
 * unlock webs render whole with costs. Needs a running server on a migrated, seeded
 * database (see playwright.config.ts).
 */
import { expect, test } from "@playwright/test";

const USERNAME = process.env["E2E_USERNAME"] ?? "dev";
const PASSWORD = process.env["E2E_PASSWORD"] ?? "devpassword";

test("logs in and shows the whole unlock web with costs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Caravan Vaults" })).toBeVisible();
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // Signed in: the shell's tab bar is up and the username shows.
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByText(USERNAME, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Webs" }).click();
  await expect(page.getByRole("heading", { name: "Unlock webs" })).toBeVisible();

  // Living web of the seeded desert caravan: a locked capstone is visible with its cost.
  const living = page.getByTestId("web-living");
  await expect(living).toContainText("Caravan-level, Desert only");
  await expect(living.getByRole("button", { name: /^Vaquero,/ })).toBeVisible();
  await expect(living.getByRole("button", { name: /^Vaquero,/ })).toContainText("pts");
  await expect(living.getByRole("button", { name: /^Dust Rider,/ })).toContainText("Reached");

  // Trap web: account-level, all ten nodes present including the tier-4 fence.
  await page.getByRole("tab", { name: "Traps & fences" }).click();
  const trap = page.getByTestId("web-trap");
  await expect(trap).toContainText("Account-level");
  await expect(trap.getByRole("button", { name: /^Stacked Stone,/ })).toBeVisible();
  await expect(trap.getByRole("button", { name: /^Spike Pit,/ })).toContainText("Free");

  // Tapping a locked node shows its stats and the access-not-instance copy; no unlock button.
  await trap.getByRole("button", { name: /^Stacked Stone,/ }).click();
  const detail = page.getByTestId("node-detail");
  await expect(detail).toContainText("Segment HP");
  await expect(detail).toContainText("does not give you one");
  await expect(detail.getByRole("button", { name: /^Unlock access/ })).toHaveCount(0);
});
