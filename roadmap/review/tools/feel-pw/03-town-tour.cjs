const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-main.json";

(async () => {
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", state: STATE, dpr: 2 });
  await page.goto(BASE + "/");
  await page.getByTestId("town-screen").waitFor({ timeout: 20000 });
  await page.waitForLoadState("networkidle");
  await sleep(1500);
  const p = await panels(page, "03-town");
  console.log(p);
  const canvas = page.getByTestId("town-screen").locator("canvas").first();
  await canvas.scrollIntoViewIfNeeded();
  await sleep(500);
  await canvas.screenshot({ path: OUT + "/03-town-canvas.png" });
  await dump(page, "03-town");
  await save(context, STATE);
  await browser.close();
})();
