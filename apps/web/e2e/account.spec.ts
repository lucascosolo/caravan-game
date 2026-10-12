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

test("guest first launch → reload → link a username → sign in again with it, same account → delete it", async ({ page, context }) => {
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
  // Final play-test review N3: not while the first-session guide runs; once it is finished or
  // skipped, a guest is asked in town (QA-30 D1: never forced) to save the progress.
  await expect(page.getByTestId("guide-roster")).toBeVisible();
  await expect(page.getByTestId("guest-save-prompt")).toHaveCount(0);
  await page.getByTestId("guide-skip").click();
  await page.getByTestId("guide-skip-confirm").click();
  await expect(page.getByTestId("guest-save-prompt")).toBeVisible();

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
  await expect(page.getByTestId("guest-save-prompt")).toHaveCount(0);

  // ── QA-30 D5: … → deleted. The typed phrase and the password, a notice, and the start card on reload ──
  await page.getByRole("button", { name: "Account", exact: true }).click();
  const del = page.getByTestId("delete-card");
  const button = del.getByRole("button", { name: "Delete my account for good" });
  await expect(button).toBeDisabled();
  await del.getByLabel("Type “delete my account” to confirm").fill("delete my account");
  await del.getByLabel("Your password").fill(password);
  await expect(button).toBeEnabled();
  const erased = page.waitForResponse((r) => r.url().endsWith("/api/me/account/delete"));
  await button.click();
  expect((await erased).status()).toBe(200);
  await expect(page.getByTestId("start-notice")).toHaveText("Your account has been deleted.");
  await page.reload();
  await expect(page.getByTestId("guest-start")).toBeVisible();
  // The linked credentials no longer sign in.
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("invalid credentials");
});
