// Visit routes with the saved state; panels of each. Usage: node tour.cjs <prefix> <route> [<route> ...]
const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
(async () => {
  const [prefix, ...routes] = process.argv.slice(2);
  const STATE = OUT + "/" + (process.env.STATE || "state-main.json");
  const w = Number(process.env.W || 390), h = Number(process.env.H || 844);
  const { browser, context, page } = await open({ width: w, height: h, scheme: process.env.SCHEME || "dark", state: STATE, dpr: 2 });
  for (const r of routes) {
    await page.goto(BASE + "/#/" + r);
    await sleep(2500);
    const name = `${prefix}-${r.replace(/\W+/g, "_")}`;
    const p = await panels(page, name, Number(process.env.MAX || 8));
    const d = await dump(page, name);
    console.log(r, "scrollH", d.scrollH, "panels", p.n);
  }
  await save(context, STATE);
  await browser.close();
})();
