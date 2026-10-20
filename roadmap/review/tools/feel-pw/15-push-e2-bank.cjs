const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-main.json";

async function visible(loc) {
  return loc.isVisible().catch(() => false);
}

(async () => {
  const { browser, context, page, logs } = await open({ width: 390, height: 844, scheme: "dark", state: STATE, dpr: 2, video: true, tag: "15-e2" });
  await page.goto(BASE + "/#/trail");
  await page.getByTestId("to-decision").waitFor({ timeout: 20000 });
  await page.getByTestId("to-decision").scrollIntoViewIfNeeded();
  await page.getByTestId("to-decision").tap();
  await page.getByTestId("push-open").waitFor({ timeout: 20000 });
  await page.getByTestId("push-open").scrollIntoViewIfNeeded();
  await page.getByTestId("push-open").tap();
  await sleep(800);
  await snap(page, "15-push-confirm");
  await page.getByTestId("push-confirm").tap();
  await page.getByTestId("search").waitFor({ timeout: 20000 });
  await sleep(500);
  await snap(page, "15-e2-unsearched");
  await page.getByTestId("search").tap();
  await page.getByTestId("candidate-list").waitFor();
  await sleep(500);
  await snap(page, "15-e2-candidates");
  await page.getByTestId("choose-0").scrollIntoViewIfNeeded();
  await page.getByTestId("choose-0").tap();
  await page.getByTestId("formation-screen").waitFor({ timeout: 20000 });
  await sleep(1500);
  await snap(page, "15-e2-formation");
  // use the guide's steps again when offered (fence, post, trap, rest), else start from last
  let used = false;
  for (const id of ["guide-do-fence", "guide-do-post", "guide-do-trap", "guide-do-rest"]) {
    let b = page.getByTestId(id);
    if (!(await visible(b))) {
      const all = page.getByTestId("guide-all-steps").locator("summary");
      if (await all.count()) {
        await all.tap();
        await sleep(200);
      }
    }
    if (await visible(b)) {
      await b.scrollIntoViewIfNeeded();
      await b.tap();
      used = true;
      await sleep(600);
    }
  }
  if (!used && (await page.getByTestId("start-from-last").count())) await page.getByTestId("start-from-last").tap();
  await sleep(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByTestId("formation-screen").getByTestId("iso-host").screenshot({ path: OUT + "/15-e2-circle.png" });
  await page.getByTestId("commit-open").scrollIntoViewIfNeeded();
  await page.getByTestId("commit-open").tap();
  await page.getByTestId("commit-confirm").waitFor();
  await sleep(1500);
  const enabled = await page.getByRole("dialog").getByTestId("commit-confirm").isEnabled();
  console.log("commit enabled", enabled);
  if (!enabled) {
    await snap(page, "15-e2-commit-refused");
    await dump(page, "15-e2-commit-refused");
  }
  await page.getByRole("dialog").getByTestId("commit-confirm").tap();
  await page.getByTestId("replay-dialog").waitFor({ timeout: 30000 });
  // watch at 1x for a while to see the moment-to-moment
  await page.getByTestId("replay-speed-1").tap().catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (await visible(page.getByTestId("replay-end-card"))) break;
    await sleep(1000);
  }
  await sleep(500);
  await snap(page, "15-e2-replay-end");
  await page.getByTestId("replay-close").tap();
  await sleep(1500);
  await snap(page, "15-e2-after-replay");
  await dump(page, "15-e2-after-replay");
  await save(context, STATE);
  console.log(logs.filter((l) => !l.includes("WebGL") && !l.includes("GL Driver")).slice(0, 10));
  await context.close();
  await browser.close();
})();
