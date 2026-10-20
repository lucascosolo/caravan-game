const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-b.json";
const vis = (l) => l.isVisible().catch(() => false);

(async () => {
  const { browser, context, page, logs } = await open({ width: 360, height: 740, scheme: "light", dpr: 2, video: true, tag: "20-overrun" });
  await page.goto(BASE + "/");
  await page.waitForLoadState("networkidle");
  await page.locator("select").first().selectOption({ label: "Badlands" });
  await sleep(300);
  await snap(page, "20-launch-badlands-360-light");
  await page.getByRole("button", { name: "Start playing" }).tap();
  await page.getByTestId("welcome-begin").waitFor();
  await page.getByTestId("welcome-begin").tap();
  await sleep(1500);
  // skip the guide
  await page.getByTestId("guide-skip").first().tap();
  await sleep(500);
  await snap(page, "20-skip-confirm");
  await dump(page, "20-skip-confirm");
  const yes = page.getByRole("button", { name: /skip/i }).last();
  await yes.tap();
  await sleep(1200);
  await snap(page, "20-town-unguided-360");
  await save(context, STATE);
  // outfit: defaults only, no fence, no trap
  await page.getByTestId("nav-outfit").scrollIntoViewIfNeeded();
  await page.getByTestId("nav-outfit").tap();
  await page.getByTestId("outfit-screen").waitFor();
  await sleep(500);
  await panels(page, "20-outfit-360", 4);
  // tick every unit
  const boxes = page.getByTestId("outfit-units").getByRole("checkbox");
  const n = await boxes.count();
  for (let i = 0; i < n; i++) if (!(await boxes.nth(i).isChecked())) await boxes.nth(i).check().catch(() => {});
  await page.getByTestId("outfit-ride-out").scrollIntoViewIfNeeded();
  await page.getByTestId("outfit-ride-out").tap();
  await page.getByTestId("outfit-confirm").tap();
  await page.getByTestId("search").waitFor({ timeout: 20000 });
  await page.getByTestId("search").tap();
  await page.getByTestId("candidate-list").waitFor();
  await sleep(500);
  await panels(page, "20-candidates-360", 4);
  // choose the party with the most raiders
  const counts = [];
  for (let i = 0; i < 3; i++) {
    const t = (await page.getByTestId(`scout-summary-${i}`).textContent().catch(() => "")) || "";
    const m = /(\d+) raiders?/.exec(t);
    counts.push(m ? Number(m[1]) : 0);
  }
  const pick = counts.indexOf(Math.max(...counts));
  console.log("raider counts", counts, "pick", pick);
  await page.getByTestId(`choose-${pick}`).scrollIntoViewIfNeeded();
  await page.getByTestId(`choose-${pick}`).tap();
  await page.getByTestId("formation-screen").waitFor({ timeout: 20000 });
  await sleep(1500);
  await snap(page, "20-formation-360");
  // post every unit through the picker
  const trayUnits = page.locator('[data-testid^="tray-unit-"]');
  const k = await trayUnits.count();
  for (let i = 0; i < k; i++) {
    const unit = trayUnits.nth(i);
    await unit.getByRole("button").first().scrollIntoViewIfNeeded();
    await unit.getByRole("button").first().tap();
    const picker = page.getByTestId("placement-picker");
    await picker.getByRole("combobox").selectOption({ index: 1 + i });
    await picker.getByRole("button", { name: "Place here" }).tap();
    await sleep(300);
    const done = page.getByRole("region", { name: "Selected" }).getByRole("button", { name: "Done" });
    if (await done.count()) await done.first().tap().catch(() => {});
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  await snap(page, "20-formation-posted-360");
  await page.getByTestId("commit-open").scrollIntoViewIfNeeded();
  await page.getByTestId("commit-open").tap();
  await page.getByTestId("commit-confirm").waitFor();
  await sleep(1500);
  await snap(page, "20-commit-360");
  await page.getByRole("dialog").getByTestId("commit-confirm").tap();
  await page.getByTestId("replay-dialog").waitFor({ timeout: 30000 });
  await page.getByTestId("replay-speed-4").tap().catch(() => {});
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < 60000) {
    if (await vis(page.getByTestId("replay-end-card"))) break;
    await sleep(900);
    if (i++ % 3 === 0) await snap(page, `20-replay-${String(i).padStart(2, "0")}`);
  }
  await sleep(600);
  await snap(page, "20-replay-end-360");
  await page.getByTestId("replay-close").tap();
  await sleep(2000);
  await panels(page, "20-after-overrun-360", 6);
  await dump(page, "20-after-overrun-360");
  await save(context, STATE);
  console.log(logs.filter((l) => !l.includes("WebGL") && !l.includes("GL Driver")).slice(0, 10));
  await context.close();
  await browser.close();
})();
