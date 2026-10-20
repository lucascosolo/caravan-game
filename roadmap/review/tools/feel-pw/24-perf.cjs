// Mid-range phone emulation: CPU 4x throttle + "Fast 3G" (DevTools preset: 562.5 ms RTT, 180 KB/s down, 84 KB/s up).
const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");

(async () => {
  const { browser, context, page, logs } = await open({ width: 390, height: 844, scheme: "dark", dpr: 2, video: true, tag: "24-perf" });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 562.5, downloadThroughput: (180 * 1024), uploadThroughput: (84 * 1024) });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Performance.enable");
  const bytes = { total: 0, byType: {} };
  cdp.on("Network.loadingFinished", (e) => { bytes.total += e.encodedDataLength; });
  cdp.on("Network.responseReceived", (e) => { const t = e.type; bytes.byType[t] = (bytes.byType[t] || 0); });
  const reqs = [];
  page.on("requestfinished", async (r) => { const s = await r.sizes().catch(() => null); reqs.push([r.url().replace(BASE, ""), s ? s.responseBodySize : 0]); });

  const t0 = Date.now();
  await page.goto(BASE + "/", { waitUntil: "commit" });
  await page.getByRole("button", { name: "Start playing" }).waitFor({ timeout: 60000 });
  const tStart = Date.now() - t0;
  const paint = await page.evaluate(() => {
    const p = performance.getEntriesByType("paint").map((e) => [e.name, Math.round(e.startTime)]);
    const nav = performance.getEntriesByType("navigation")[0];
    return { p, dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) };
  });
  console.log("launch: Start playing visible at", tStart, "ms", JSON.stringify(paint), "bytes so far", bytes.total);
  await snap(page, "24-perf-launch");
  const t1 = Date.now();
  await page.getByRole("button", { name: "Start playing" }).tap();
  await page.getByTestId("welcome-begin").waitFor({ timeout: 60000 });
  console.log("start -> welcome", Date.now() - t1, "ms");
  const t2 = Date.now();
  await page.getByTestId("welcome-begin").tap();
  await page.getByTestId("town-screen").waitFor({ timeout: 60000 });
  const tTownDom = Date.now() - t2;
  await page.getByTestId("town-screen").locator("canvas").first().waitFor({ timeout: 60000 });
  // wait until the canvas has non-background pixels drawn (two rAFs after the element shows)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const tTownCanvas = Date.now() - t2;
  console.log("begin -> town DOM", tTownDom, "ms; -> town canvas", tTownCanvas, "ms; total bytes", bytes.total);
  await sleep(1500);
  await snap(page, "24-perf-town");
  const m = await cdp.send("Performance.getMetrics");
  const get = (n) => (m.metrics.find((x) => x.name === n) || {}).value;
  console.log("JSHeapUsed MB", (get("JSHeapUsedSize") / 1048576).toFixed(1), "Nodes", get("Nodes"), "LayoutCount", get("LayoutCount"), "TaskDuration s", get("TaskDuration").toFixed(2));
  // frame pacing on the town canvas with the mine wheel turning (the town's one animation)
  const frames = await page.evaluate(() => new Promise((res) => {
    const ts = []; let last = performance.now(); const end = last + 3000;
    const f = (t) => { ts.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(ts); };
    requestAnimationFrame(f);
  }));
  const sorted = [...frames].sort((a, b) => a - b);
  console.log("town rAF: n", frames.length, "median", sorted[Math.floor(sorted.length / 2)].toFixed(1), "p95", sorted[Math.floor(sorted.length * 0.95)].toFixed(1), "max", sorted[sorted.length - 1].toFixed(1));
  console.log("requests:", reqs.length);
  for (const [u, s] of reqs.sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log("  ", String(s).padStart(8), u.slice(0, 90));
  await save(context, OUT + "/state-perf.json");
  await context.close();
  await browser.close();
})();
