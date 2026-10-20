const { open, sleep, BASE, OUT } = require("./lib.cjs");
(async () => {
  const STATE = OUT + "/" + (process.env.STATE || "state-b.json");
  const { browser, page } = await open({ width: 390, height: 844, scheme: "dark", dpr: 1, state: STATE });
  for (const r of process.argv.slice(2)) {
    await page.goto(BASE + "/#/" + r);
    await sleep(2500);
    const w = await page.evaluate(() => {
      const t = (document.querySelector("main") || document.body).innerText;
      const words = t.split(/\s+/).filter(Boolean).length;
      const server = (t.match(/\bserver\b/gi) || []).length;
      return { words, server };
    });
    console.log(r, JSON.stringify(w));
  }
  await browser.close();
})();
