const { open, snap, dump, sleep, BASE } = require("./lib.cjs");

(async () => {
  const sizes = [
    [390, 844],
    [360, 740],
    [320, 568],
  ];
  for (const scheme of ["dark", "light"]) {
    for (const [w, h] of sizes) {
      const { browser, page, logs } = await open({ width: w, height: h, scheme });
      const t0 = Date.now();
      await page.goto(BASE + "/");
      // the first thing the player sees, and then whatever settles
      await sleep(150);
      await snap(page, `01-launch-early-${w}-${scheme}`);
      await page.waitForLoadState("networkidle");
      await sleep(600);
      await snap(page, `01-launch-${w}-${scheme}`);
      await snap(page, `01-launch-${w}-${scheme}-full`, { full: true });
      if (w === 390 && scheme === "dark") await dump(page, "01-launch");
      console.log(scheme, w, "settled in", Date.now() - t0, "ms", logs.slice(0, 5));
      await browser.close();
    }
  }
})();
