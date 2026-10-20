// Continue a trip with the in-game help: DO=push|bank at the decision; then search, take the guide's pick
// (or CHOOSE index), "Arrange for me" if offered (else Quick arrange on raider sides), commit, read the result.
const W = (p, ms) => p.waitForTimeout(ms);
export default async ({ page, shot, text, log, tid }) => {
  await page.goto("/#/trail"); await W(page, 3500);
  if (await tid("to-decision").count()) { await tid("to-decision").click(); await W(page, 1500); }
  if (await tid("bank-open").count()) {
    const advice = await tid("guide-advice").getAttribute("data-advice").catch(() => null);
    const pv = (await text("main")).match(/Worth \d+ Coin if survived[^\n]*/)?.[0];
    const choice = process.env.DO ?? advice ?? "bank";
    log(`DECISION advice=${advice} next: ${pv} → ${choice}`);
    await page.evaluate(() => window.scrollTo(0, 0)); await shot("decision");
    if (choice === "bank") {
      await tid("bank-open").click(); await W(page, 700); await tid("bank-confirm").click(); await W(page, 3000);
      await page.evaluate(() => window.scrollTo(0, 0)); await shot("bank-summary");
      log("SUMMARY:", (await text("main")).replace(/\n/g, " | ").slice(0, 1200));
      return;
    }
    await tid("push-open").click(); await W(page, 700); await tid("push-confirm").click(); await W(page, 3000);
  }
  if (await tid("search").count()) { await tid("search").click(); await W(page, 3500); }
  let pick = process.env.CHOOSE ?? (await tid("guide-scout-pick").getAttribute("data-index").catch(() => null)) ?? "0";
  const cards = page.locator('[data-testid="candidate-list"] > *');
  const nc = await cards.count();
  const lines = [];
  for (let i = 0; i < nc; i++) lines.push((await cards.nth(i).innerText()).split("\n").filter((l) => /raiders$|^[◉▼◆]|Total HP|^\d{3,5}$|from range|^◎|^○|authored|standing party/.test(l)).join(" ; "));
  log(`MENU:\n  - ${lines.join("\n  - ")}\n  pick ${pick}`);
  if (await tid(`choose-${pick}`).count()) { await tid(`choose-${pick}`).click(); await W(page, 4000); }
  if (await tid("assist-arrange-do").count()) { await tid("assist-arrange-do").click(); await W(page, 1200); log("arranged for me"); }
  else {
    const qa = tid("quick-arrange").getByRole("button");
    const n = await qa.count();
    for (let i = 0; i < n; i++) { const t = await qa.nth(i).innerText(); if (/raider/.test(t) && (await qa.nth(i).isEnabled())) { await qa.nth(i).click(); await W(page, 400); } }
    log("quick arranged raider sides (no assist)");
  }
  await page.locator('[data-testid="formation-screen"] [data-testid="iso-host"]').scrollIntoViewIfNeeded().catch(() => {});
  await shot("arranged");
  await tid("commit-open").click(); await W(page, 1200);
  const cd = (await text("[role=dialog]")).replace(/\n/g, " | ");
  if (/will not take/.test(cd)) { log("COMMIT REFUSED:", cd.slice(0, 500)); return; }
  await tid("commit-confirm").click();
  await tid("replay-dialog").waitFor({ timeout: 90000 }).catch(() => {});
  await W(page, 6000); await shot("replay");
  await tid("replay-close").click().catch(() => {}); await W(page, 2500);
  const main = await text("main");
  log("RESULT:", (main.match(/Encounter \d+: results[\s\S]*?Watch the fight/g)?.pop() ?? main.slice(0, 600)).replace(/\n/g, " | ").slice(0, 900));
};
