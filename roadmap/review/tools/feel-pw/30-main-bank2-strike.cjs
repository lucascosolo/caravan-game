const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const STATE = OUT + "/state-main.json";
const vis = (l) => l.isVisible().catch(() => false);

async function arrange(page) {
  if (await page.getByTestId("start-from-last").count()) {
    await page.getByTestId("start-from-last").scrollIntoViewIfNeeded();
    await page.getByTestId("start-from-last").tap();
    await sleep(1200);
  }
  // fence the sides with raiders, then post everything still in the wagon
  for (const e of ["north", "east", "south", "west"]) {
    const b = page.getByTestId(`fence-side-${e}`);
    if ((await b.count()) && (await b.isEnabled().catch(() => false))) { await b.tap().catch(() => {}); await sleep(200); }
  }
  const trayUnits = page.locator('[data-testid^="tray-unit-"]');
  const k = await trayUnits.count();
  for (let i = 0; i < k; i++) {
    const unit = trayUnits.nth(i);
    if (/Posted at/.test((await unit.textContent()) || "")) continue;
    if (/Dead/.test((await unit.textContent()) || "")) continue;
    await unit.getByRole("button").first().scrollIntoViewIfNeeded();
    await unit.getByRole("button").first().tap();
    const picker = page.getByTestId("placement-picker");
    if (!(await picker.count())) continue;
    await picker.getByRole("combobox").selectOption({ index: 1 + i });
    await picker.getByRole("button", { name: "Place here" }).tap();
    await sleep(300);
    const done = page.getByRole("region", { name: "Selected" }).getByRole("button", { name: "Done" });
    if (await done.count()) await done.first().tap().catch(() => {});
  }
}

async function commitAndSkip(page) {
  await page.getByTestId("commit-open").scrollIntoViewIfNeeded();
  await page.getByTestId("commit-open").tap();
  await page.getByTestId("commit-confirm").waitFor();
  await sleep(1500);
  if (!(await page.getByRole("dialog").getByTestId("commit-confirm").isEnabled())) {
    await snap(page, "30-commit-refused");
    await dump(page, "30-commit-refused");
    throw new Error("commit refused");
  }
  await page.getByRole("dialog").getByTestId("commit-confirm").tap();
  await page.getByTestId("replay-dialog").waitFor({ timeout: 30000 });
  await page.getByTestId("replay-close").tap();
  await sleep(2000);
}

(async () => {
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", dpr: 2, state: STATE });
  await page.goto(BASE + "/#/trail");
  await page.getByTestId("formation-screen").waitFor({ timeout: 30000 });
  await sleep(1500);
  await arrange(page);
  await commitAndSkip(page);
  if (await vis(page.getByTestId("trip-summary"))) console.log("trip 2 ended (overrun?)");
  else {
    await page.getByTestId("to-decision").scrollIntoViewIfNeeded();
    await page.getByTestId("to-decision").tap();
    await page.getByTestId("bank-open").waitFor();
    await page.getByTestId("bank-open").scrollIntoViewIfNeeded();
    await page.getByTestId("bank-open").tap();
    await page.getByTestId("bank-confirm").tap();
    await page.getByTestId("trip-summary").waitFor();
    console.log("trip 2 banked");
  }
  // trip 3
  await page.goto(BASE + "/#/town");
  await page.getByTestId("town-screen").waitFor();
  await sleep(1500);
  await page.getByTestId("nav-outfit").scrollIntoViewIfNeeded();
  await page.getByTestId("nav-outfit").tap();
  await page.getByTestId("outfit-screen").waitFor();
  if (await page.getByTestId("outfit-same-as-last").count()) await page.getByTestId("outfit-same-as-last").tap();
  await page.getByTestId("outfit-ride-out").tap();
  await page.getByTestId("outfit-confirm").tap();
  await page.getByTestId("search").waitFor({ timeout: 20000 });
  await page.getByTestId("search").tap();
  await page.getByTestId("candidate-list").waitFor();
  await sleep(800);
  await snap(page, "30-trip3-candidates");
  const texts = [];
  for (let i = 0; i < 3; i++) texts.push(((await page.getByTestId(`candidate-${i}`).textContent().catch(() => "")) || "").slice(0, 80));
  console.log(texts);
  let pick = texts.findIndex((t) => !/authored party/.test(t));
  console.log("non-authored candidate index", pick);
  await dump(page, "30-trip3-candidates");
  if (pick >= 0) {
    await page.getByTestId(`candidate-${pick}`).screenshot({ path: OUT + "/30-player-party-candidate.png" });
    await page.getByTestId(`choose-${pick}`).scrollIntoViewIfNeeded();
    await page.getByTestId(`choose-${pick}`).tap();
    await page.getByTestId("formation-screen").waitFor({ timeout: 20000 });
    await sleep(1200);
    await arrange(page);
    await commitAndSkip(page);
    console.log("fought the player party");
  }
  await save(context, STATE);
  await browser.close();
})();
