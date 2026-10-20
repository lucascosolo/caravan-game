// Usage: node run.mjs <profile> <snippet.mjs> [width height]
// Keeps a per-profile storageState (the device cookie) so each run is a "reload" of the same phone.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(new URL("../../../../apps/web/package.json", import.meta.url));
const { chromium, devices } = require("@playwright/test");

const [, , profile, snippet, w = "360", h = "740"] = process.argv;
const SP = process.env.STUDIO_DIR ?? "./studio-out";
const stateFile = path.join(SP, "studio/state", `${profile}.json`);
const shotDir = path.join(SP, "studio/shots", profile);
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.mkdirSync(shotDir, { recursive: true });
const BASE = process.env.BASE ?? "http://127.0.0.1:3935";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  ...devices["Pixel 5"],
  viewport: { width: Number(w), height: Number(h) },
  baseURL: BASE,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
  ...(fs.existsSync(stateFile) ? { storageState: stateFile } : {}),
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
const apiLog = [];
page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("/api/") && r.status() >= 400) apiLog.push(`${r.status()} ${r.request().method()} ${u.replace(BASE, "")}`);
});
let n = 0;
const shot = async (name, full = false) => {
  n++;
  const f = path.join(shotDir, `${String(Date.now()).slice(-7)}-${name}.png`);
  await page.screenshot({ path: f, fullPage: full });
  console.log("SHOT", f);
  return f;
};
const text = async (sel = "main") => (await page.locator(sel).first().innerText().catch(() => "")).replace(/\n{2,}/g, "\n");
const tid = (id) => page.getByTestId(id);
const has = async (id) => (await tid(id).count()) > 0;
const api = async (method, url, body) => {
  // uses the page's bearer? The client holds the token in memory; we re-auth via resume cookie
  const r = await page.evaluate(async ([method, url, body]) => {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, credentials: "include" });
    return { status: res.status, body: await res.text() };
  }, [method, url, body]);
  return r;
};
const mod = await import(path.resolve(snippet));
try {
  await mod.default({ page, ctx, shot, text, tid, has, api, log: console.log, profile, SP });
} catch (e) {
  console.log("ERROR", e.message.split("\n").slice(0, 6).join("\n"));
  await shot("error").catch(() => {});
} finally {
  await ctx.storageState({ path: stateFile });
  if (errors.length) console.log("PAGE ERRORS:\n" + errors.slice(0, 15).join("\n"));
  if (apiLog.length) console.log("API >=400:\n" + apiLog.slice(0, 30).join("\n"));
  await browser.close();
}
