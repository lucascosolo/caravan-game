const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-b.json";
const vis = (l) => l.isVisible().catch(() => false);

(async () => {
  const { browser, context, page, logs } = await open({ width: 360, height: 740, scheme: "dark", state: STATE, dpr: 2, video: true, tag: "21-overrun" });
  await page.goto(BASE + "/#/trail");
  await sleep(2500);
  for (let round = 2; round <= 6; round++) {
    if (await vis(page.getByTestId("trip-summary"))) break;
    await page.getByTestId("to-decision").scrollIntoViewIfNeeded();
    await page.getByTestId("to-decision").tap();
    await page.getByTestId("push-open").waitFor({ timeout: 20000 });
    await page.getByTestId("push-open").scrollIntoViewIfNeeded();
    await page.getByTestId("push-open").tap();
    await page.getByTestId("push-confirm").tap();
    await page.getByTestId("search").waitFor({ timeout: 20000 });
    await page.getByTestId("search").tap();
    await page.getByTestId("candidate-list").waitFor();
    const counts = [];
    for (let i = 0; i < 3; i++) {
      const t = (await page.getByTestId(`scout-summary-${i}`).textContent().catch(() => "")) || "";
      const m = /(\d+) raiders?/.exec(t);
      counts.push(m ? Number(m[1]) : 0);
    }
    const pick = counts.indexOf(Math.max(...counts));
    console.log("round", round, "raiders", counts, "pick", pick);
    await page.getByTestId(`choose-${pick}`).scrollIntoViewIfNeeded();
    await page.getByTestId(`choose-${pick}`).tap();
    await page.getByTestId("formation-screen").waitFor({ timeout: 20000 });
    await sleep(1200);
    if (await page.getByTestId("start-from-last").count()) {
      await page.getByTestId("start-from-last").scrollIntoViewIfNeeded();
      await page.getByTestId("start-from-last").tap();
      await sleep(1500);
    }
    await page.getByTestId("commit-open").scrollIntoViewIfNeeded();
    await page.getByTestId("commit-open").tap();
    await page.getByTestId("commit-confirm").waitFor();
    await sleep(1500);
    if (!(await page.getByRole("dialog").getByTestId("commit-confirm").isEnabled())) {
      await snap(page, `21-commit-refused-${round}`);
      await dump(page, `21-commit-refused-${round}`);
      console.log("commit refused");
      break;
    }
    await page.getByRole("dialog").getByTestId("commit-confirm").tap();
    await page.getByTestId("replay-dialog").waitFor({ timeout: 30000 });
    await page.getByTestId("replay-speed-4").tap().catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (await vis(page.getByTestId("replay-end-card"))) break;
      await sleep(500);
    }
    await sleep(400);
    await snap(page, `21-replay-end-${round}`);
    const outcome = (await page.getByTestId("replay-end-card").textContent().catch(() => "")) || "";
    console.log("round", round, outcome.slice(0, 80));
    await page.getByTestId("replay-close").tap();
    await sleep(2000);
    if (/overrun/i.test(outcome)) {
      await panels(page, "21-overrun-summary", 8);
      await dump(page, "21-overrun-summary");
      break;
    }
  }
  await save(context, STATE);
  console.log(logs.filter((l) => !l.includes("WebGL") && !l.includes("GL Driver")).slice(0, 10));
  await context.close();
  await browser.close();
})();
