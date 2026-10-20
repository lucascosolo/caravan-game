const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-main.json";

(async () => {
  const { browser, context, page, logs } = await open({ width: 390, height: 844, scheme: "dark", state: STATE, dpr: 2, video: true, tag: "04-outfit" });
  await page.goto(BASE + "/");
  await page.getByTestId("town-screen").waitFor({ timeout: 20000 });
  await page.waitForLoadState("networkidle");
  await sleep(800);
  // Guide: show me the refugees
  await page.getByTestId("guide-roster-show").tap();
  await sleep(700);
  await snap(page, "04-refugees-shown");
  const offer = page.getByTestId("refugee-offers").getByRole("button", { name: /^Take / }).first();
  const name = (await offer.textContent()).trim();
  const t0 = Date.now();
  await offer.tap();
  await snap(page, "04-refugee-tap-50ms");
  await page.getByTestId("refugee-panel").getByRole("status").waitFor();
  console.log("take ->status", Date.now() - t0, "ms", name);
  await sleep(300);
  await snap(page, "04-refugee-taken");
  await page.getByTestId("guide-outfit").waitFor({ timeout: 10000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await snap(page, "04-guide-outfit");
  await dump(page, "04-guide-outfit");
  // Outfit
  await page.getByTestId("nav-outfit").tap();
  await sleep(1200);
  await page.waitForLoadState("networkidle");
  await panels(page, "05-outfit");
  await dump(page, "05-outfit");
  await save(context, STATE);
  console.log(logs.filter((l) => !l.includes("WebGL") && !l.includes("GL Driver")).slice(0, 10));
  await context.close();
  await browser.close();
})();
