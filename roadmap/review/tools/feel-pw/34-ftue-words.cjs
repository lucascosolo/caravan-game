// A fresh guided first session: words on screen (guide cards / whole main) at each step, and taps, until the first result.
const { open, snap, sleep, BASE, OUT } = require("./lib.cjs");
(async () => {
  const { browser, context, page } = await open({ width: 390, height: 844, scheme: "dark", dpr: 1 });
  let taps = 0;
  const t0 = Date.now();
  const words = async (label) => {
    const w = await page.evaluate(() => {
      const c = (s) => s.split(/\s+/).filter(Boolean).length;
      const guide = [...document.querySelectorAll(".guide, [data-testid=onboarding-welcome]")].map((e) => e.innerText).join(" ");
      const main = (document.querySelector("main") || document.body).innerText;
      return { guide: c(guide), main: c(main) };
    });
    console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s taps ${String(taps).padStart(2)}  ${label.padEnd(28)} guide ${w.guide}  screen ${w.main}`);
    return w;
  };
  const tap = async (loc) => { await loc.scrollIntoViewIfNeeded(); await loc.tap(); taps++; };
  await page.goto(BASE + "/");
  await page.waitForLoadState("networkidle");
  await words("launch");
  await tap(page.getByRole("button", { name: "Start playing" }));
  await page.getByTestId("welcome-begin").waitFor();
  await words("welcome");
  await tap(page.getByTestId("welcome-begin"));
  await page.getByTestId("guide-roster-show").waitFor();
  await sleep(800);
  await words("town: take a refugee");
  await tap(page.getByTestId("guide-roster-show"));
  await tap(page.getByTestId("refugee-offers").getByRole("button", { name: /^Take / }).first());
  await page.getByTestId("guide-outfit").waitFor();
  await words("town: pack and ride out");
  await tap(page.getByTestId("nav-outfit"));
  await page.getByTestId("outfit-screen").waitFor();
  await sleep(500);
  await words("outfit");
  await tap(page.getByTestId("outfit-traps").getByRole("button", { name: "Add Spike Pit" }));
  await page.getByTestId("outfit-fence-tier").selectOption({ index: 1 }); taps += 2;
  await tap(page.getByTestId("outfit-ride-out"));
  await tap(page.getByTestId("outfit-confirm"));
  await page.getByTestId("search").waitFor();
  await words("trail: search");
  await tap(page.getByTestId("search"));
  await page.getByTestId("candidate-list").waitFor();
  await sleep(500);
  await words("candidates");
  const pick = (await page.getByTestId("guide-scout-pick").getAttribute("data-index")) || "0";
  await tap(page.getByTestId(`choose-${pick}`));
  await page.getByTestId("formation-screen").waitFor();
  await sleep(1200);
  await words("arrange");
  for (const id of ["guide-do-fence", "guide-do-post", "guide-do-trap", "guide-do-rest"]) {
    const b = page.getByTestId(id);
    if (!(await b.isVisible().catch(() => false))) { const all = page.getByTestId("guide-all-steps").locator("summary"); if (await all.count()) { await all.tap(); taps++; } }
    await tap(b);
    await sleep(400);
  }
  await words("arranged");
  await tap(page.getByTestId("commit-open"));
  await page.waitForFunction(() => !document.querySelector("[role=dialog] [data-testid=commit-confirm]")?.disabled, null, { timeout: 30000 });
  await tap(page.getByRole("dialog").getByTestId("commit-confirm"));
  await page.getByTestId("replay-dialog").waitFor({ timeout: 30000 });
  await words("fight starts");
  await page.getByTestId("replay-end-card").waitFor({ timeout: 90000 });
  await words("fight ends (first aha)");
  await tap(page.getByTestId("replay-close"));
  await page.getByTestId("encounter-results").waitFor();
  await sleep(800);
  await words("results");
  await browser.close();
})();
