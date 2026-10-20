const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const STATE = OUT + "/state-main.json";

(async () => {
  const { browser, context, page, logs } = await open({ width: 390, height: 844, scheme: "dark", video: true, tag: "02-welcome" });
  await page.goto(BASE + "/");
  await page.waitForLoadState("networkidle");
  // Region choices
  const opts = await page.locator("select").first().locator("option").allTextContents();
  console.log("regions:", opts);
  const t0 = Date.now();
  await page.getByRole("button", { name: "Start playing" }).tap();
  await snap(page, "02-after-start-100ms");
  await page.getByTestId("onboarding-welcome").waitFor({ timeout: 20000 });
  console.log("start -> welcome", Date.now() - t0, "ms");
  await sleep(400);
  await snap(page, "02-welcome");
  await snap(page, "02-welcome-full", { full: true });
  await dump(page, "02-welcome");
  await page.getByTestId("welcome-begin").tap();
  await sleep(1500);
  await page.waitForLoadState("networkidle");
  await sleep(1500);
  await snap(page, "03-town-first");
  await snap(page, "03-town-first-full", { full: true });
  await dump(page, "03-town-first");
  await save(context, STATE);
  console.log(logs.slice(0, 10));
  await context.close();
  await browser.close();
})();
