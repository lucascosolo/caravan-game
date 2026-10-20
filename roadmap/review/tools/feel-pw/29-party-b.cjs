const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const { panels } = require("./lib2.cjs");
const STATE = OUT + "/state-b.json";
(async () => {
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", dpr: 2, state: STATE, video: true, tag: "29-partyb" });
  await page.goto(BASE + "/#/party");
  await page.getByTestId("party-save").waitFor({ timeout: 30000 });
  await sleep(1500);
  await snap(page, "29-party-empty");
  await panels(page, "29-party-empty", 4);
  const adds = page.getByRole("button", { name: /^Add / });
  for (let i = 0; i < 4; i++) {
    await adds.first().scrollIntoViewIfNeeded();
    await adds.first().tap();
    await sleep(400);
  }
  await page.getByTestId("party-save").scrollIntoViewIfNeeded();
  await snap(page, "29-party-before-save");
  await page.getByTestId("party-save").tap();
  await sleep(1500);
  await snap(page, "29-party-after-save");
  await dump(page, "29-party-after-save");
  await save(context, STATE);
  await context.close();
  await browser.close();
})();
