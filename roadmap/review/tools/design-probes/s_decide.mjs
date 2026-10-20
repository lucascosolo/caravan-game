export default async ({ page, shot, text, log, tid }) => {
  await page.goto("/#/trail");
  await page.waitForTimeout(3500);
  if (await tid("to-decision").count()) { await tid("to-decision").click(); await page.waitForTimeout(1500); }
  await page.evaluate(() => window.scrollTo(0, 0)); await shot("decision");
  log("=== DECISION ===\n" + (await text("main")));
  const advice = await tid("guide-advice").getAttribute("data-advice").catch(() => null);
  const choice = process.env.DO ?? advice ?? "bank";
  log("ADVICE", advice, "DOING", choice);
  if (choice === "none") return;
  if (choice === "push") {
    await tid("push-open").click();
    await page.waitForTimeout(800);
    log("=== PUSH DIALOG ===\n" + (await text("[role=dialog]")));
    await tid("push-confirm").click();
  } else {
    await tid("bank-open").click();
    await page.waitForTimeout(800);
    log("=== BANK DIALOG ===\n" + (await text("[role=dialog]")));
    await tid("bank-confirm").click();
  }
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0)); await shot("after-decision");
  log("=== AFTER ===\n" + (await text("body")));
};
