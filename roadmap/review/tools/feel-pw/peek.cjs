// Open a route with the saved state, screenshot it, dump it. Usage: node peek.cjs <hash> <name> [state]
const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
(async () => {
  const [hash, name, st] = process.argv.slice(2);
  const STATE = OUT + "/" + (st || "state-main.json");
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", state: STATE, dpr: 2 });
  await page.goto(BASE + "/#/" + hash);
  await sleep(3000);
  await snap(page, name);
  const d = await dump(page, name);
  for (const i of d.items) if (["button", "h1", "h2", "h3", "summary"].includes(i.tag)) console.log(i.y, i.h, i.tag, i.id || "", i.text.slice(0, 70));
  await save(context, STATE);
  await browser.close();
})();
