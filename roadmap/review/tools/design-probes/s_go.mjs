// Generic step: goto HASH, optionally click a sequence of testids / button names, shot viewport(s), dump text.
// ENV: HASH (#/town), CLICKS="tid:foo|role:Take Dust Rider|wait:2000|scroll:tid", SHOTS=name, DUMP=1, SEL=main
const W = (p, ms) => p.waitForTimeout(ms);
export default async ({ page, shot, text, log, tid }) => {
  await page.goto("/" + (process.env.HASH ?? ""));
  await W(page, 3000);
  const steps = (process.env.CLICKS ?? "").split("|").filter(Boolean);
  for (const s of steps) {
    const [kind, ...rest] = s.split(":");
    const arg = rest.join(":");
    try {
      if (kind === "tid") await tid(arg).first().click();
      else if (kind === "tidn") { const [id, k] = arg.split("="); const loc = tid(id); const n = await loc.count(); for (let i = 0; i < n; i++) if (await loc.nth(i).isEnabled()) { if (Number(k) === 0) { await loc.nth(i).click(); break; } } }
      else if (kind === "role") await page.getByRole("button", { name: arg }).first().click();
      else if (kind === "text") await page.getByText(arg).first().click();
      else if (kind === "wait") await W(page, Number(arg));
      else if (kind === "scroll") await tid(arg).first().scrollIntoViewIfNeeded();
      else if (kind === "top") await page.evaluate(() => window.scrollTo(0, 0));
      else if (kind === "shot") await shot(arg);
      else if (kind === "select") { const [id, v] = arg.split("="); await tid(id).selectOption(v); }
      else if (kind === "selidx") { const [id, v] = arg.split("="); await tid(id).selectOption({ index: Number(v) }); }
      else if (kind === "check") await tid(arg).check();
      else if (kind === "dump") log(`DUMP ${arg}:\n` + (await text(arg === "" ? "main" : arg)));
      else if (kind === "key") await page.keyboard.press(arg);
      await W(page, 700);
    } catch (e) { log("STEP FAIL", s, e.message.split("\n")[0]); }
  }
  if (process.env.DUMP) log("TEXT:\n" + (await text(process.env.SEL ?? "main")));
};
