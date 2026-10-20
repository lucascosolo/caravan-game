const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const STATE = OUT + "/state-perf.json";

async function throttle(cdp, on) {
  await cdp.send("Network.emulateNetworkConditions", on ? { offline: false, latency: 562.5, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024 } : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: on ? 4 : 1 });
}
const pace = (page, ms) =>
  page.evaluate((dur) => new Promise((res) => {
    const ts = []; let last = performance.now(); const end = last + dur;
    const f = (t) => { ts.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(ts); };
    requestAnimationFrame(f);
  }), ms);
const stats = (fr) => {
  const s = [...fr].sort((a, b) => a - b);
  const long = fr.filter((x) => x > 50).length;
  return `n ${fr.length} (${(fr.length / (fr.reduce((a, b) => a + b, 0) / 1000)).toFixed(1)} fps) median ${s[Math.floor(s.length / 2)].toFixed(1)} p95 ${s[Math.floor(s.length * 0.95)].toFixed(1)} max ${s[s.length - 1].toFixed(1)} frames>50ms ${long}`;
};

(async () => {
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", dpr: 2, state: STATE });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  await page.goto(BASE + "/#/town");
  await page.getByTestId("town-screen").waitFor({ timeout: 30000 });
  await sleep(1000);
  // fast setup, unthrottled
  if (await page.getByTestId("guide-roster-show").count()) {
    await page.getByTestId("guide-roster-show").tap();
    await page.getByTestId("refugee-offers").getByRole("button", { name: /^Take / }).first().tap();
    await sleep(1500);
  }
  await page.getByTestId("nav-outfit").scrollIntoViewIfNeeded();
  await page.getByTestId("nav-outfit").tap();
  await page.getByTestId("outfit-traps").getByRole("button", { name: "Add Spike Pit" }).tap();
  await page.getByTestId("outfit-fence-tier").selectOption({ index: 1 });
  await page.getByTestId("outfit-ride-out").tap();
  await page.getByTestId("outfit-confirm").tap();
  await page.getByTestId("search").waitFor({ timeout: 20000 });
  await page.getByTestId("search").tap();
  await page.getByTestId("candidate-list").waitFor();
  const pick = (await page.getByTestId("guide-scout-pick").getAttribute("data-index").catch(() => "0")) || "0";
  // throttle from here
  await throttle(cdp, true);
  const t0 = Date.now();
  await page.getByTestId(`choose-${pick}`).scrollIntoViewIfNeeded();
  await page.getByTestId(`choose-${pick}`).tap();
  await page.getByTestId("formation-screen").locator("canvas").first().waitFor({ timeout: 60000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  console.log("choose -> formation canvas (throttled)", Date.now() - t0, "ms");
  console.log("formation idle:", stats(await pace(page, 3000)));
  // guided taps, each timed until the next frame
  for (const id of ["guide-do-fence", "guide-do-post", "guide-do-trap", "guide-do-rest"]) {
    const b = page.getByTestId(id);
    if (!(await b.isVisible().catch(() => false))) {
      const all = page.getByTestId("guide-all-steps").locator("summary");
      if (await all.count()) await all.tap();
    }
    const tt = Date.now();
    await b.tap();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    console.log(" ", id, "tap -> painted", Date.now() - tt, "ms");
  }
  // drag a canvas pan to measure interaction pacing
  const host = page.getByTestId("formation-screen").getByTestId("iso-host");
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await host.boundingBox();
  const p = pace(page, 2500);
  await page.mouse.move(box.x + 60, box.y + box.height - 40);
  await page.mouse.down();
  for (let i = 0; i < 30; i++) { await page.mouse.move(box.x + 60 + i * 6, box.y + box.height - 40 - i * 2); await sleep(30); }
  await page.mouse.up();
  console.log("formation pan:", stats(await p));
  let m = await cdp.send("Performance.getMetrics");
  const heap = (mm) => ((mm.metrics.find((x) => x.name === "JSHeapUsedSize") || {}).value / 1048576).toFixed(1);
  console.log("heap after formation MB", heap(m));
  // commit and the replay
  await page.getByTestId("commit-open").scrollIntoViewIfNeeded();
  await page.getByTestId("commit-open").tap();
  await page.getByTestId("commit-confirm").waitFor();
  await page.waitForFunction(() => !document.querySelector("[role=dialog] [data-testid=commit-confirm]")?.disabled, null, { timeout: 60000 });
  const t1 = Date.now();
  await page.getByRole("dialog").getByTestId("commit-confirm").tap();
  await page.getByTestId("replay-dialog").waitFor({ timeout: 60000 });
  const tDialog = Date.now() - t1;
  await page.getByTestId("replay-stage").locator("canvas").first().waitFor({ timeout: 60000 });
  await page.getByTestId("replay-time").waitFor({ timeout: 60000 });
  console.log("commit -> replay dialog", tDialog, "ms; -> stage with clock", Date.now() - t1, "ms (throttled)");
  console.log("replay playing:", stats(await pace(page, 5000)));
  await snap(page, "25-perf-replay");
  m = await cdp.send("Performance.getMetrics");
  console.log("heap during replay MB", heap(m));
  // open/close the replay a few times to look for growth
  await page.getByTestId("replay-close").tap();
  await sleep(1500);
  await throttle(cdp, false);
  const heaps = [];
  for (let i = 0; i < 5; i++) {
    const w = page.getByTestId("watch-fight").first();
    await w.scrollIntoViewIfNeeded();
    await w.tap();
    await page.getByTestId("replay-time").waitFor({ timeout: 30000 });
    await sleep(1500);
    await page.getByTestId("replay-close").tap();
    await sleep(800);
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    m = await cdp.send("Performance.getMetrics");
    heaps.push(heap(m));
  }
  console.log("heap after each open/close of the replay (MB):", heaps.join(", "));
  const gl = await page.evaluate(() => document.querySelectorAll("canvas").length);
  console.log("canvases in DOM after", gl);
  await save(context, STATE);
  await browser.close();
})();
