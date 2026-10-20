const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-main.json";

(async () => {
  const { browser, context, page, logs } = await open({ width: 390, height: 844, scheme: "dark", state: STATE, dpr: 2, video: true, tag: "17-party" });
  await page.goto(BASE + "/#/trail");
  await page.getByTestId("guide-raise-party").waitFor({ timeout: 20000 });
  await page.getByTestId("guide-raise-party").tap();
  await page.waitForURL(/#\/party/, { timeout: 20000 });
  await sleep(2000);
  await panels(page, "17-party-raised", 10);
  await dump(page, "17-party-raised");
  const host = page.getByTestId("party-screen").getByTestId("iso-host");
  if (await host.count()) await host.screenshot({ path: OUT + "/17-party-canvas.png" });
  await page.getByTestId("guide-finish").scrollIntoViewIfNeeded();
  await page.getByTestId("guide-finish").tap();
  await sleep(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await snap(page, "17-party-after-finish");
  await save(context, STATE);
  console.log(logs.filter((l) => !l.includes("WebGL") && !l.includes("GL Driver")).slice(0, 10));
  await context.close();
  await browser.close();
})();
