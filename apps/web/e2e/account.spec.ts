/**
 * Account lifecycle e2e (chunk 30): the guest-first launch against the real server.
 *
 *   first launch → pick a region → a GUEST account (no username, no password) → the first
 *   screen of the guide → a reload stays signed in (the server's HttpOnly device cookie; the
 *   page stores nothing) → the Account screen links a username + password to the SAME account
 *   → a reload is still that account, now named → sign out → sign in with the new credentials
 *   on the same account id.
 */
import { expect, test } from "@playwright/test";

test("guest first launch → reload → link a username → sign in again with it, same account", async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 640 });
  const username = `e2e_guest_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const password = "e2e-password-1";

  // ── first launch: no sign-up, just the region ──
  await page.goto("/");
  const start = page.getByTestId("guest-start");
  await expect(start).toBeVisible();
  await expect(start).toContainText("Permanent: chosen once for this caravan and never swapped.");
  await start.getByRole("combobox").selectOption("high_plains");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/auth/guest") && r.status() === 201);
  await start.getByRole("button", { name: "Start playing" }).click();
  const accountId = ((await (await created).json()) as { account: { id: string } }).account.id;

  // A new account opens on the guide's first screen (chunk 24), played as a guest.
  await expect(page.getByTestId("onboarding-welcome")).toBeVisible();
  await expect(page.getByTestId("welcome-region")).toContainText("High Plains");
  await expect(page.getByTestId("guest-badge")).toBeVisible();
  await page.getByTestId("welcome-begin").click();

  // The device credential is an HttpOnly cookie: present for the browser, invisible to the page.
  const cookie = (await context.cookies()).find((c) => c.name === "caravan_device");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  expect(await page.evaluate(() => document.cookie)).not.toContain("caravan_device");

  // ── a reload keeps the guest ──
  await page.reload();
  await expect(page.getByTestId("guest-badge")).toBeVisible();
  await expect(page.getByTestId("guest-start")).toHaveCount(0);

  // ── the Account screen: save the progress ──
  await page.getByRole("button", { name: "Account", exact: true }).click();
  const link = page.getByTestId("link-card");
  await expect(link).toContainText("You are playing as a guest.");
  await link.getByLabel("Username").fill(username);
  await link.getByLabel("Password").fill(password);
  await link.getByRole("button", { name: "Save with this username" }).click();
  await expect(page.getByText(`Signed in as ${username}.`)).toBeVisible();
  await expect(page.getByTestId("guest-badge")).toHaveCount(0);
  await expect(page.getByText(username, { exact: true })).toBeVisible();
  await expect(page.getByTestId("device-row")).toHaveCount(1);

  // ── reload: the same account, now named ──
  await page.reload();
  await expect(page.getByText(username, { exact: true })).toBeVisible();

  // ── sign out, then sign in with the linked credentials: the same account id ──
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByTestId("guest-start")).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  const login = page.waitForResponse((r) => r.url().endsWith("/api/auth/login") && r.status() === 200);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect(((await (await login).json()) as { account: { id: string; guest: boolean } }).account).toMatchObject({ id: accountId, guest: false });
  await expect(page.getByText(username, { exact: true })).toBeVisible();
});
