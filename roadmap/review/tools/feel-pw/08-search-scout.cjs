const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-main.json";

(async () => {
  const { browser, context, page, logs } = await open({ width: 390, height: 844, scheme: "dark", state: STATE, dpr: 2, video: true, tag: "08-scout" });
  await page.goto(BASE + "/#/trail");
  await page.getByTestId("search").waitFor({ timeout: 20000 });
  const t0 = Date.now();
  await page.getByTestId("search").tap();
  await snap(page, "08-search-tap-50ms");
  await page.getByTestId("candidate-list").waitFor();
  console.log("search -> list", Date.now() - t0);
  await sleep(500);
  await panels(page, "08-candidates", 14);
  await dump(page, "08-candidates");
  const pick = await page.getByTestId("guide-scout-pick").getAttribute("data-index").catch(() => "0");
  console.log("guide pick", pick);
  // open full scouting report on the pick if there is a disclosure
  const full = page.getByTestId(`candidate-${pick}`).locator("summary").first();
  if (await full.count()) {
    await full.tap();
    await sleep(400);
    await full.scrollIntoViewIfNeeded();
    await snap(page, "08-scout-full-open");
    await page.getByTestId(`candidate-${pick}`).screenshot({ path: OUT + "/08-candidate-pick-full.png" });
  }
  await page.getByTestId(`choose-${pick}`).scrollIntoViewIfNeeded();
  const t1 = Date.now();
  await page.getByTestId(`choose-${pick}`).tap();
  await page.getByTestId("formation-screen").waitFor({ timeout: 20000 });
  console.log("choose -> formation", Date.now() - t1);
  await sleep(1500);
  await snap(page, "09-formation-first");
  await panels(page, "09-formation", 16);
  await dump(page, "09-formation");
  await save(context, STATE);
  console.log(logs.filter((l) => !l.includes("WebGL") && !l.includes("GL Driver")).slice(0, 10));
  await context.close();
  await browser.close();
})();
