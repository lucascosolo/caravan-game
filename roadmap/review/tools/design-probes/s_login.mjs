export default async ({ page, shot, text, log, tid }) => {
  await page.goto("/");
  await page.waitForTimeout(2500);
  await page.locator("form").filter({ hasText: "Sign in" }).getByLabel("Username").fill(process.env.U);
  await page.locator("form").filter({ hasText: "Sign in" }).getByLabel("Password").fill(process.env.P ?? "r4-password-123");
  await page.locator("form").filter({ hasText: "Sign in" }).getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(3500);
  await shot("signed-in");
  log((await text("main")).split("\n").slice(0, 14).join(" | "));
};
