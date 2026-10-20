// Shared Playwright helpers for the studio-feel review (not part of the repo).
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
const path = require("path");
const fs = require("fs");
const { chromium } = require("/home/user/caravan-game/.claude/worktrees/agent-a0a750c9427565bad/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright");

const BASE = process.env.BASE || "http://localhost:3933";
const OUT = "/tmp/claude-0/-home-user-caravan-game/edcaf182-6a4d-5af1-b736-5ca8113d60f8/scratchpad/sf-review/shots";
fs.mkdirSync(OUT, { recursive: true });

async function open({ width = 390, height = 844, scheme = "dark", video = false, state = null, reducedMotion = "no-preference", dpr = 3, tag = "run" } = {}) {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const ctxOpts = {
    viewport: { width, height },
    deviceScaleFactor: dpr,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
    reducedMotion,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  };
  if (video) ctxOpts.recordVideo = { dir: path.join(OUT, "video", tag), size: { width, height } };
  if (state && fs.existsSync(state)) ctxOpts.storageState = state;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  return { browser, context, page, logs };
}

async function snap(page, name, { full = false } = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  return file;
}

/** A compact dump of what is on screen: headings, buttons, inputs, status lines. */
async function dump(page, name) {
  const d = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const txt = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140);
    const out = [];
    for (const el of document.querySelectorAll("h1,h2,h3,button,a[href],input,select,summary,[role=status],[data-testid]")) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute("data-testid") || undefined,
        text: el.tagName === "INPUT" || el.tagName === "SELECT" ? el.getAttribute("aria-label") || el.name || el.type : txt(el),
        y: Math.round(r.top + window.scrollY),
        h: Math.round(r.height),
        w: Math.round(r.width),
        dis: el.disabled || undefined,
      });
    }
    return { url: location.href, scrollH: document.documentElement.scrollHeight, vh: innerHeight, items: out };
  });
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(d, null, 1));
  return d;
}

async function save(context, file) {
  await context.storageState({ path: file });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { open, snap, dump, save, sleep, BASE, OUT };
