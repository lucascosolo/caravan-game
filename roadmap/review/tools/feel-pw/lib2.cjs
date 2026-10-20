const { snap, sleep } = require("./lib.cjs");
/** Viewport screenshots down the whole page, one per screen height. */
async function panels(page, name, max = 12) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = await page.evaluate(() => innerHeight);
  const files = [];
  let i = 0;
  for (let y = 0; y < h && i < max; y += vh - 60, i++) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await sleep(250);
    files.push(await snap(page, `${name}-p${i}`));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return { h, vh, n: files.length };
}
module.exports = { panels };
