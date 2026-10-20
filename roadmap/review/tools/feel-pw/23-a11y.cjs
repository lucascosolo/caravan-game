const { open, snap, dump, save, sleep, BASE, OUT } = require("./lib.cjs");
const STATE = OUT + "/state-b.json";

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement;
    const small = [...document.querySelectorAll("button, select, summary, a[href], input")]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.height < 44 || r.width < 44);
      })
      .map((b) => `${b.tagName}:${(b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 30)}:${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`);
    const clipped = [...document.querySelectorAll("button")].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => (b.textContent || "").trim().slice(0, 30));
    return { sideScroll: doc.scrollWidth - innerWidth, small: small.slice(0, 12), clipped: clipped.slice(0, 8), h: doc.scrollHeight };
  });
}

(async () => {
  // 1) 150% text at 320x568
  {
    const { browser, context, page } = await open({ width: 320, height: 568, scheme: "dark", state: STATE, dpr: 2 });
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const s = document.createElement("style");
        s.textContent = "html{font-size:150% !important}";
        document.head.appendChild(s);
      });
    });
    for (const r of ["town", "webs", "party", "inbox"]) {
      await page.goto(BASE + "/#/" + r);
      await sleep(2500);
      await snap(page, `23-text150-320-${r}`);
      console.log("150%", r, JSON.stringify(await overflow(page)));
    }
    await page.goto(BASE + "/#/town");
    await sleep(2000);
    await page.getByTestId("nav-outfit").scrollIntoViewIfNeeded();
    await page.getByTestId("nav-outfit").tap();
    await sleep(1500);
    await snap(page, "23-text150-320-outfit");
    console.log("150% outfit", JSON.stringify(await overflow(page)));
    await page.getByTestId("outfit-ride-out").scrollIntoViewIfNeeded();
    await snap(page, "23-text150-320-outfit-bottom");
    await browser.close();
  }
  // 2) landscape phone 844x390
  {
    const { browser, page } = await open({ width: 844, height: 390, scheme: "dark", state: STATE, dpr: 2 });
    for (const r of ["town", "party", "webs"]) {
      await page.goto(BASE + "/#/" + r);
      await sleep(2500);
      await snap(page, `23-landscape-${r}`);
      console.log("landscape", r, JSON.stringify(await overflow(page)));
    }
    await browser.close();
  }
  // 3) 320x568 default text, sizes of the shell
  {
    const { browser, page } = await open({ width: 320, height: 568, scheme: "dark", state: STATE, dpr: 2 });
    for (const r of ["town", "trail", "party", "webs", "packs", "account"]) {
      await page.goto(BASE + "/#/" + r);
      await sleep(2000);
      await snap(page, `23-320-${r}`);
      console.log("320", r, JSON.stringify(await overflow(page)));
    }
    await browser.close();
  }
})();
