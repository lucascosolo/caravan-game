const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const STATE = OUT + "/state-b.json";
(async () => {
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", dpr: 2, state: STATE });
  await page.goto(BASE + "/#/webs");
  await sleep(2000);
  await page.getByRole("button", { name: /Town/ }).last().tap();
  await sleep(1500);
  await page.getByTestId("nav-outfit").scrollIntoViewIfNeeded();
  await page.getByTestId("nav-outfit").tap();
  await page.getByTestId("outfit-screen").waitFor();
  console.log("in outfit, url", page.url(), "history", await page.evaluate(() => history.length));
  await page.goBack();
  await sleep(1500);
  console.log("after system back from outfit:", page.url(), "outfit visible:", await page.getByTestId("outfit-screen").isVisible().catch(() => false));
  await snap(page, "32-back-from-outfit");
  // a dialog open, then back
  await page.goto(BASE + "/#/town");
  await sleep(2000);
  const merge = page.getByTestId("merge-2-1").first();
  if (await merge.count()) {
    await merge.scrollIntoViewIfNeeded();
    await merge.tap();
    await sleep(800);
    console.log("merge dialog open:", await page.getByRole("dialog").isVisible().catch(() => false), page.url());
    await page.goBack();
    await sleep(1500);
    console.log("after back with dialog open:", page.url(), "dialog still open:", await page.getByRole("dialog").isVisible().catch(() => false));
    await snap(page, "32-back-with-dialog");
  }
  await browser.close();
})();
