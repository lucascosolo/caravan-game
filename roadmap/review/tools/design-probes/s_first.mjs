// First look: a fresh guest, screen by screen, with full text dumps.
const W = (p, ms) => p.waitForTimeout(ms);
export default async ({ page, shot, text, log, tid }) => {
  await page.goto("/");
  await W(page, 3000);
  await shot("00-start", true);
  log("START TEXT:\n" + (await text("body")));
  if (await tid("guest-start").count()) {
    await page.getByLabel("Region").first().selectOption(process.env.REGION ?? "desert");
    await shot("01-region");
    await page.getByRole("button", { name: "Start playing" }).click();
    await W(page, 3500);
  }
  await shot("02-welcome", true);
  log("WELCOME TEXT:\n" + (await text("body")));
  if (await tid("welcome-begin").count()) { await tid("welcome-begin").click(); await W(page, 3000); }
  await shot("03-town", true);
  log("TOWN TEXT:\n" + (await text("body")));
};
