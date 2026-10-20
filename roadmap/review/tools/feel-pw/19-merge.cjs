const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const STATE = OUT + "/state-main.json";

(async () => {
  const { browser, context, page, logs } = await open({ width: 390, height: 844, scheme: "dark", state: STATE, dpr: 2, video: true, tag: "19-merge" });
  await page.goto(BASE + "/#/town");
  await page.getByTestId("town-screen").waitFor({ timeout: 20000 });
  await sleep(2000);
  const canvas = page.getByTestId("town-screen").locator("canvas").first();
  await canvas.scrollIntoViewIfNeeded();
  await sleep(600);
  const box = await canvas.boundingBox();
  console.log("canvas box", box);
  await canvas.screenshot({ path: OUT + "/19-town-canvas-before.png" });
  // drag the first WD onto the second (positions read off the earlier screenshot, CSS px)
  const a = { x: box.x + 177, y: box.y + 82 };
  const b = { x: box.x + 205, y: box.y + 97 };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
    await sleep(40);
  }
  await canvas.screenshot({ path: OUT + "/19-town-canvas-dragging.png" });
  await page.mouse.up();
  await sleep(1000);
  await snap(page, "19-after-drop");
  await dump(page, "19-after-drop");
  const confirm = page.getByTestId("merge-confirm");
  if (await confirm.isVisible().catch(() => false)) {
    await snap(page, "19-merge-dialog");
    const t0 = Date.now();
    await confirm.tap();
    await snap(page, "19-merge-tap");
    await sleep(1500);
    console.log("merge confirm", Date.now() - t0);
    await snap(page, "19-after-merge");
    await canvas.scrollIntoViewIfNeeded();
    await sleep(300);
    await canvas.screenshot({ path: OUT + "/19-town-canvas-after.png" });
    await dump(page, "19-after-merge");
  } else {
    console.log("no merge dialog after drag");
  }
  await save(context, STATE);
  console.log(logs.filter((l) => !l.includes("WebGL") && !l.includes("GL Driver")).slice(0, 10));
  await context.close();
  await browser.close();
})();
