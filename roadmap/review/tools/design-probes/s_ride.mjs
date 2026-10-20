// Outfit and ride out; then search and dump the candidates. ENV: TRAPS (6), PACKALL, PACK (count), FENCEIDX (last)
const W = (p, ms) => p.waitForTimeout(ms);
export default async ({ page, shot, text, log, tid }) => {
  await page.goto("/#/town");
  await W(page, 3000);
  await tid("nav-outfit").click();
  await W(page, 2500);
  const boxes = tid("outfit-units").getByRole("checkbox");
  const nb = await boxes.count();
  if (process.env.PACKALL) for (let i = 0; i < nb; i++) { if (await boxes.nth(i).isEnabled()) await boxes.nth(i).check().catch(() => {}); }
  let checked = 0; for (let i = 0; i < nb; i++) if (await boxes.nth(i).isChecked()) checked++;
  if (!checked) { if (await tid("outfit-whole-roster").count()) await tid("outfit-whole-roster").click(); await W(page, 500); }
  if (process.env.PACK) {
    const want = Number(process.env.PACK);
    let c = 0;
    for (let i = 0; i < nb; i++) { if (await boxes.nth(i).isChecked()) c++; }
    for (let i = nb - 1; i >= 0 && c > want; i--) { if (await boxes.nth(i).isChecked()) { await boxes.nth(i).uncheck(); c--; } }
    for (let i = 0; i < nb && c < want; i++) { if (!(await boxes.nth(i).isChecked()) && (await boxes.nth(i).isEnabled())) { await boxes.nth(i).check(); c++; } }
  }
  checked = 0; for (let i = 0; i < nb; i++) if (await boxes.nth(i).isChecked()) checked++;
  const traps = Number(process.env.TRAPS ?? 6);
  for (let i = 0; i < traps; i++) {
    const adds = tid("outfit-traps").getByRole("button", { name: /^Add / });
    const na = await adds.count();
    const add = adds.nth(i % Math.max(na, 1));
    if ((await add.count()) && (await add.isEnabled())) await add.click();
    await W(page, 120);
  }
  const tier = tid("outfit-fence-tier");
  const nopt = await tier.locator("option").count();
  await tier.selectOption({ index: process.env.FENCEIDX ? Number(process.env.FENCEIDX) : nopt - 1 });
  await W(page, 500);
  if (await tid("outfit-fence-count").count()) {
    const fc = tid("outfit-fence-count");
    const tag = await fc.evaluate((e) => e.tagName);
    log("fence count control:", tag, await fc.inputValue().catch(() => "?"));
  }
  log(`OUTFIT: ${checked}/${nb} units; ` + (await tid("outfit-packed").innerText().catch(() => "")).replace(/\n/g, " | "));
  await shot("outfit");
  await tid("outfit-ride-out").click();
  await W(page, 800);
  log("RIDE DIALOG:", (await text("[role=dialog]")).replace(/\n/g, " | "));
  await tid("outfit-confirm").click();
  await W(page, 3500);
  if (await tid("search").count()) { await tid("search").click(); await W(page, 3500); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("candidates-top");
  log("CANDIDATES:\n" + (await text("main")));
};
