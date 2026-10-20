const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-main.json";

(async () => {
  const { browser, context, page, logs } = await open({ width: 390, height: 844, scheme: "dark", state: STATE, dpr: 2, video: true, tag: "13-decide" });
  await page.goto(BASE + "/#/trail");
  await sleep(2500);
  await snap(page, "13-trail-return");
  const close = page.getByTestId("replay-close");
  if (await close.isVisible().catch(() => false)) {
    await close.tap();
    await sleep(800);
  }
  await page.getByTestId("encounter-results").waitFor({ timeout: 20000 });
  await sleep(500);
  await panels(page, "13-results", 6);
  await dump(page, "13-results");
  await page.getByTestId("to-decision").scrollIntoViewIfNeeded();
  await page.getByTestId("to-decision").tap();
  await page.getByTestId("bank-or-push").waitFor();
  await sleep(800);
  await panels(page, "14-decide", 10);
  await dump(page, "14-decide");
  await save(context, STATE);
  console.log(logs.filter((l) => !l.includes("WebGL") && !l.includes("GL Driver")).slice(0, 10));
  await context.close();
  await browser.close();
})();
