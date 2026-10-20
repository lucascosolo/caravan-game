const fs = require("fs");
const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const STATE = OUT + "/state-main.json";
const pace = (page, ms) =>
  page.evaluate((dur) => new Promise((res) => {
    const ts = []; let last = performance.now(); const end = last + dur;
    const f = (t) => { ts.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(ts); };
    requestAnimationFrame(f);
  }), ms);
const stats = (fr) => {
  const s = [...fr].sort((a, b) => a - b);
  return `n ${fr.length} (${(fr.length / (fr.reduce((a, b) => a + b, 0) / 1000)).toFixed(1)} fps) median ${s[Math.floor(s.length / 2)].toFixed(1)} p95 ${s[Math.floor(s.length * 0.95)].toFixed(1)} max ${s[s.length - 1].toFixed(1)}`;
};

(async () => {
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", dpr: 2, state: STATE });
  const cdp = await context.newCDPSession(page);
  await page.goto(BASE + "/#/town");
  await page.getByTestId("town-screen").waitFor({ timeout: 30000 });
  await sleep(1500);
  console.log("town idle (1x):", stats(await pace(page, 3000)));
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  console.log("town idle (4x CPU):", stats(await pace(page, 3000)));
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.getByTestId("nav-outfit").scrollIntoViewIfNeeded();
  await page.getByTestId("nav-outfit").tap();
  await page.getByTestId("outfit-screen").waitFor();
  if (await page.getByTestId("outfit-same-as-last").count()) await page.getByTestId("outfit-same-as-last").tap();
  else {
    await page.getByTestId("outfit-fence-tier").selectOption({ index: 1 });
  }
  await sleep(300);
  await page.getByTestId("outfit-ride-out").tap();
  await page.getByTestId("outfit-confirm").tap();
  await page.getByTestId("search").waitFor({ timeout: 20000 });
  await page.getByTestId("search").tap();
  await page.getByTestId("candidate-list").waitFor();
  await page.getByTestId("choose-0").scrollIntoViewIfNeeded();
  await page.getByTestId("choose-0").tap();
  await page.getByTestId("formation-screen").locator("canvas").first().waitFor({ timeout: 60000 });
  await sleep(1500);
  console.log("formation idle (1x):", stats(await pace(page, 3000)));
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  console.log("formation idle (4x CPU):", stats(await pace(page, 3000)));
  // profile 3 s of idle formation under 4x
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  await cdp.send("Profiler.start");
  await sleep(3000);
  const { profile } = await cdp.send("Profiler.stop");
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log("top self time, formation idle, 4x CPU (of", (total / 1000).toFixed(0), "ms):");
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log("  ", ((v / total) * 100).toFixed(1).padStart(5) + "%", k);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  // tap -> paint unthrottled for the guided step
  for (const id of ["guide-do-fence", "guide-do-post"]) {
    const b = page.getByTestId(id);
    if (!(await b.isVisible().catch(() => false))) {
      const all = page.getByTestId("guide-all-steps").locator("summary");
      if (await all.count()) await all.tap();
    }
    if (!(await b.isVisible().catch(() => false))) continue;
    const tt = Date.now();
    await b.tap();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    console.log("  1x", id, "tap -> painted", Date.now() - tt, "ms");
  }
  await save(context, STATE);
  await browser.close();
})();
