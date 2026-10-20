const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const STATE = OUT + "/state-main.json";

(async () => {
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", dpr: 2, state: STATE });
  await page.goto(BASE + "/#/trail");
  await page.getByTestId("formation-screen").waitFor({ timeout: 30000 });
  await sleep(1500);
  await context.setOffline(true);
  // try to commit while offline
  await page.getByTestId("commit-open").scrollIntoViewIfNeeded();
  await page.getByTestId("commit-open").tap();
  await sleep(2500);
  await snap(page, "27-offline-commit");
  await dump(page, "27-offline-commit");
  await page.keyboard.press("Escape").catch(() => {});
  const no = page.getByRole("dialog").getByRole("button", { name: /keep arranging/i });
  if (await no.count()) await no.tap();
  await sleep(500);
  // switch tab while offline
  await page.getByRole("button", { name: /Town/ }).last().tap();
  await sleep(3000);
  await snap(page, "27-offline-town");
  await dump(page, "27-offline-town");
  await page.getByRole("button", { name: /Webs/ }).last().tap();
  await sleep(3000);
  await snap(page, "27-offline-webs");
  await context.setOffline(false);
  // a route that does not exist, and the admin route for a player
  await page.goto(BASE + "/#/nowhere");
  await sleep(2000);
  await snap(page, "27-unknown-route");
  console.log("unknown route lands on", page.url());
  await page.goto(BASE + "/#/admin");
  await sleep(2000);
  await snap(page, "27-admin-as-player");
  // slow network: what loading looks like between tabs (1.5 s RTT)
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 1500, downloadThroughput: 100 * 1024, uploadThroughput: 50 * 1024 });
  await page.goto(BASE + "/#/town");
  await sleep(2500);
  await snap(page, "27-slow-town-loading");
  await page.getByRole("button", { name: /Party/ }).last().tap();
  await sleep(700);
  await snap(page, "27-slow-party-loading");
  await page.getByRole("button", { name: /Webs/ }).last().tap();
  await sleep(700);
  await snap(page, "27-slow-webs-loading");
  await page.getByRole("button", { name: /Trail/ }).last().tap();
  await sleep(700);
  await snap(page, "27-slow-trail-loading");
  await sleep(4000);
  await snap(page, "27-slow-trail-loaded");
  await browser.close();
})();
