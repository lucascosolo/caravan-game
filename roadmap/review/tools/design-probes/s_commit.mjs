export default async ({ page, shot, text, log, tid }) => {
  await page.goto("/#/trail");
  await page.waitForTimeout(3500);
  const stepsLog = [];
  if (!process.env.NOGUIDE) {
    for (let i = 0; i < 10; i++) {
      const btn = page.locator('[data-testid="guide-current"] [data-testid^="guide-do-"]').first();
      if (!(await btn.count())) break;
      const id = await btn.getAttribute("data-testid");
      const t = await btn.innerText();
      await btn.click();
      await page.waitForTimeout(700);
      stepsLog.push(`${id}: ${t}`);
    }
  }
  log("STEPS", stepsLog);
  log("=== GUIDE AFTER STEPS ===\n" + (await text(".guide")));
  log("budget:", await tid("budget-meter").innerText().catch(() => "?"));
  await page.locator('[data-testid="iso-host"]').scrollIntoViewIfNeeded();
  await shot("arranged");
  await tid("commit-open").click();
  await page.waitForTimeout(1500);
  log("=== COMMIT DIALOG ===\n" + (await text("[role=dialog]")));
  await shot("commitdialog");
  await page.getByRole("dialog").getByTestId("commit-confirm").click();
  const dialog = tid("replay-dialog");
  await dialog.waitFor({ timeout: 60000 });
  const t0 = Date.now();
  for (const s of [2, 6, 12, 20]) {
    await page.waitForTimeout(Math.max(0, s * 1000 - (Date.now() - t0)));
    if (!(await dialog.count())) break;
    await shot(`replay-${s}s`);
  }
  log("=== REPLAY DIALOG TEXT ===\n" + (await text("[data-testid=replay-dialog]")));
  if (process.env.WATCH) {
    // watch to end
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(2000);
      const t = await text("[data-testid=replay-dialog]");
      if (/held|overrun|withdr/i.test(t) && i > 3) break;
    }
    await shot("replay-end");
    log("=== REPLAY END TEXT ===\n" + (await text("[data-testid=replay-dialog]")));
  }
  const close = tid("replay-close");
  if (await close.count()) await close.click();
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.scrollTo(0, 0)); await shot("result");
  log("=== RESULT ===\n" + (await text("main")));
};
