/**
 * Final play-test review round 2, S1: about nine page loads in five minutes used to sign a guest
 * out — the session a resume had just issued was evicted at once, every call after it answered
 * 401, and the app fell back to the start screen (the client fix round turned that into the retry
 * card; the reviewer then saw reloads 10–15 land on it). With the server fix (the session being
 * issued is never evicted; a resume replaces the session it names), 50 reloads within a minute
 * all land back in the game, signed in as the same guest, and no authed call answers 401.
 */
import { expect, test } from "@playwright/test";

test("50 reloads in a minute stay signed in: every one is back in town as the same guest, never the retry card or the start screen", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  const start = page.getByTestId("guest-start");
  await expect(start).toBeVisible();
  await start.getByRole("combobox").selectOption("desert");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/auth/guest") && r.status() === 201);
  await start.getByRole("button", { name: "Start playing" }).click();
  const accountId = ((await (await created).json()) as { account: { id: string } }).account.id;
  await expect(page.getByTestId("onboarding-welcome")).toBeVisible();
  await page.getByTestId("welcome-begin").click();
  await page.getByTestId("guide-skip").click();
  await page.getByTestId("guide-skip-confirm").click();
  await expect(page.getByTestId("guest-badge")).toBeVisible();

  // Count every 401 from the API, and which account each resume signs in as.
  const unauthorized: string[] = [];
  const resumedAs: string[] = [];
  page.on("response", async (r) => {
    if (!r.url().includes("/api/")) return;
    if (r.status() === 401) unauthorized.push(`${r.request().method()} ${new URL(r.url()).pathname}`);
    if (new URL(r.url()).pathname.endsWith("/api/auth/resume") && r.status() === 200) {
      try {
        resumedAs.push(((await r.json()) as { account: { id: string } }).account.id);
      } catch {
        /* the page navigated away before the body was read */
      }
    }
  });

  const began = Date.now();
  for (let i = 1; i <= 50; i++) {
    await page.reload();
    await expect(page.getByTestId("guest-badge"), `reload ${i}`).toBeVisible();
    await expect(page.getByTestId("resume-failed"), `reload ${i}`).toHaveCount(0);
    await expect(page.getByTestId("guest-start"), `reload ${i}`).toHaveCount(0);
  }
  const elapsed = Date.now() - began;
  expect(elapsed, "the 50 reloads took longer than a minute; the check needs them inside the window").toBeLessThan(60_000);

  expect(unauthorized, unauthorized.join("\n")).toEqual([]);
  expect(resumedAs.length).toBeGreaterThan(0);
  expect(new Set(resumedAs)).toEqual(new Set([accountId]));
  // The game still answers as that guest after the 50th reload.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByTestId("link-card")).toContainText("You are playing as a guest.");
});
