const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const STATE = OUT + "/state-main.json";
(async () => {
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", dpr: 2, state: STATE });
  await page.goto(BASE + "/#/trail");
  await page.getByTestId("candidate-list").waitFor({ timeout: 30000 });
  for (let r = 0; r < 2; r++) {
    await page.waitForFunction(() => !document.querySelector("[data-testid=reroll]")?.disabled, null, { timeout: 240000 });
    await page.getByTestId("reroll").tap();
    await sleep(2500);
    const texts = [];
    for (let i = 0; i < 3; i++) texts.push(((await page.getByTestId(`candidate-${i}`).textContent().catch(() => "")) || "").slice(0, 60));
    console.log("reroll", r, texts);
    const pick = texts.findIndex((t) => t && !/authored party/.test(t));
    if (pick >= 0) {
      await page.getByTestId(`candidate-${pick}`).scrollIntoViewIfNeeded();
      await page.getByTestId(`candidate-${pick}`).screenshot({ path: OUT + "/31-player-party-candidate.png" });
      console.log("player party at", pick);
      break;
    }
  }
  await save(context, STATE);
  await browser.close();
})();
