// Hand arrangement through the real UI. PLAN env JSON:
// { "choose": 0|null, "sides": ["South","East"], "traps": ["15,20", ...], "posts": [["15,17","guard"], ...], "commit": true }
const W = (p, ms) => p.waitForTimeout(ms);
export default async ({ page, shot, text, log, tid }) => {
  const plan = JSON.parse(process.env.PLAN ?? "{}");
  await page.goto("/#/trail");
  await W(page, 3500);
  if (plan.choose !== undefined && plan.choose !== null && (await tid(`choose-${plan.choose}`).count())) { await tid(`choose-${plan.choose}`).click(); await W(page, 4000); }
  if (plan.clear && (await tid("clear-open").count())) { await tid("clear-open").click(); await W(page, 600); await tid("clear-confirm").click().catch(() => {}); await W(page, 800); }
  for (const side of plan.sides ?? []) {
    const b = tid("quick-arrange").getByRole("button", { name: new RegExp(`^Fence ${side}`) });
    if (await b.count()) { await b.first().click(); await W(page, 500); } else log("no quick-arrange for", side);
  }
  const place = async (chip, value) => {
    await chip.locator("button").first().click().catch(async () => { await chip.click(); });
    await W(page, 400);
    const sel = tid("picker-select");
    if (!(await sel.count())) { log("no picker for", await chip.getAttribute("data-testid")); return false; }
    const vals = await sel.locator("option:not([disabled])").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    if (!vals.includes(value)) { log("cell not offered", value, "near:", vals.slice(0, 8).join(" ")); return false; }
    await sel.selectOption(value);
    await tid("picker-place").click();
    await W(page, 400);
    return true;
  };
  const trapChips = page.locator('[data-testid^="tray-trap-"]');
  for (let i = 0; i < (plan.traps ?? []).length; i++) await place(trapChips.nth(i), plan.traps[i]);
  const unitChips = page.locator('[data-testid^="tray-unit-"]');
  for (let i = 0; i < (plan.posts ?? []).length; i++) {
    const [cell, stance] = plan.posts[i];
    const ok = await place(unitChips.nth(i), cell);
    if (ok && stance && stance !== "guard") {
      await unitChips.nth(i).locator("button").first().click().catch(() => {});
      await W(page, 400);
      const sb = tid("stance-picker").getByRole("radio", { name: new RegExp(stance, "i") });
      if (await sb.count()) { await sb.first().click(); await W(page, 400); } else log("no stance button", stance);
    }
  }
  const done = page.getByRole("region", { name: "Selected" }).getByRole("button", { name: "Done" });
  if (await done.count()) await done.click().catch(() => {});
  log("budget:", await tid("budget-meter").innerText().catch(() => "?"));
  log("edges:", (await tid("edge-reports").innerText().catch(() => "")).replace(/\n/g, " | "));
  await page.locator('[data-testid="formation-screen"] [data-testid="iso-host"]').scrollIntoViewIfNeeded().catch(() => {});
  await shot("placed");
  if (!plan.commit) return;
  await tid("commit-open").click();
  await W(page, 1200);
  log("COMMIT:", (await text("[role=dialog]")).replace(/\n/g, " | ").slice(0, 700));
  await page.getByRole("dialog").getByTestId("commit-confirm").click();
  const dialog = tid("replay-dialog");
  await dialog.waitFor({ timeout: 90000 }).catch(() => log("no replay dialog"));
  const t0 = Date.now();
  for (const s of [3, 8, 14]) { await W(page, Math.max(0, s * 1000 - (Date.now() - t0))); if (!(await dialog.count())) break; await shot(`replay-${s}s`); }
  for (let i = 0; i < 40; i++) { await W(page, 1500); const t = await text("[data-testid=replay-dialog]"); if (/End of the fight/.test(t)) break; }
  await shot("replay-end");
  log("REPLAY:", (await text("[data-testid=replay-dialog]")).replace(/\n/g, " | ").slice(0, 1600));
  await tid("replay-close").click().catch(() => {});
  await W(page, 2500);
  log("RESULT:", (await text("main")).replace(/\n/g, " | ").slice(0, 1500));
};
