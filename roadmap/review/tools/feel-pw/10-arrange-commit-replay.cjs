const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-main.json";

(async () => {
  const { browser, context, page, logs } = await open({ width: 390, height: 844, scheme: "dark", state: STATE, dpr: 2, video: true, tag: "10-commit" });
  await page.goto(BASE + "/#/trail");
  await page.getByTestId("formation-screen").waitFor({ timeout: 20000 });
  await sleep(1200);
  let taps = 0;
  for (const id of ["guide-do-fence", "guide-do-post", "guide-do-trap", "guide-do-rest"]) {
    const b = page.getByTestId(id);
    if (!(await b.isVisible().catch(() => false))) {
      // open "All steps"
      const all = page.getByTestId("guide-all-steps").locator("summary");
      if (await all.count()) await all.tap();
      await sleep(200);
    }
    await b.scrollIntoViewIfNeeded();
    await b.tap();
    taps++;
    await sleep(700);
    await snap(page, `10-after-${id}`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  const host = page.getByTestId("formation-screen").getByTestId("iso-host");
  await host.screenshot({ path: OUT + "/10-circle-arranged.png" });
  await panels(page, "10-arranged", 3);
  // commit
  await page.getByTestId("commit-open").scrollIntoViewIfNeeded();
  await snap(page, "10-commit-button");
  await page.getByTestId("commit-open").tap();
  taps++;
  await page.getByTestId("commit-confirm").waitFor();
  await sleep(1200);
  await snap(page, "10-commit-dialog");
  await dump(page, "10-commit-dialog");
  const t0 = Date.now();
  await page.getByRole("dialog").getByTestId("commit-confirm").tap();
  taps++;
  // capture the anticipation and the replay
  for (let i = 0; i < 6; i++) {
    await sleep(250);
    await snap(page, `11-post-commit-${String(i).padStart(2, "0")}`);
  }
  const dialog = page.getByTestId("replay-dialog");
  await dialog.waitFor({ timeout: 30000 });
  console.log("commit -> replay dialog", Date.now() - t0, "ms; taps so far", taps);
  await page.getByTestId("replay-stage").waitFor({ timeout: 30000 }).catch(() => {});
  const t1 = Date.now();
  let i = 0;
  while (Date.now() - t1 < 45000) {
    await snap(page, `12-replay-${String(i).padStart(3, "0")}`);
    i++;
    const ended = await page.getByTestId("replay-end-card").isVisible().catch(() => false);
    if (ended) {
      console.log("end card at", Date.now() - t1, "ms");
      break;
    }
    await sleep(700);
  }
  await sleep(1000);
  await snap(page, "12-replay-end");
  await dump(page, "12-replay-end");
  const stage = page.getByTestId("replay-stage");
  if (await stage.count()) await stage.screenshot({ path: OUT + "/12-replay-stage-end.png" });
  // the player below the stage
  await page.getByTestId("replay-player").evaluate((el) => el.closest("[role=dialog]")?.scrollBy(0, 600));
  await sleep(400);
  await snap(page, "12-replay-below");
  await save(context, STATE);
  console.log(logs.filter((l) => !l.includes("WebGL") && !l.includes("GL Driver")).slice(0, 10));
  await context.close();
  await browser.close();
})();
