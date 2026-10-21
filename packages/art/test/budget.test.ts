import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BATTLE_LIMIT_BYTES, TOWN_LIMIT_BYTES, measureBudget } from "../src/budget.ts";

/** A built dist in a scratch directory (the repo's dist/ is gitignored, so no checked-in fixture). */
let dist = "";
const put = (p: string, content: string | number): void => {
  writeFileSync(join(dist, p), typeof content === "number" ? Buffer.alloc(content, 1) : content);
};
const size = (p: string) => statSync(join(dist, p)).size;
const atlas = { town: 1000, battle: 500 };

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "art-budget-"));
  mkdirSync(join(dist, "assets"));
  put(
    "index.html",
    `<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"><script type="module" src="/assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-a1.css"></head><body></body></html>`,
  );
  put("manifest.webmanifest", "{}");
  // the entry: statically imports a shared chunk, names an image, lists lazy chunks in a preload map
  put(
    "assets/index-a1.js",
    `import{s}from"./shared-c3.js";const logo="/assets/logo-q1.png";const deps=["assets/replay-b2.js","assets/replay-b2.css"];import("./replay-b2.js");`,
  );
  put("assets/shared-c3.js", "export const s=1;");
  put("assets/logo-q1.png", 300);
  // the CSS: a 9-slice image used twice, a font, a data URI (inline, no extra file), a missing file
  put(
    "assets/index-a1.css",
    `@font-face{font-family:X;src:url(/assets/face-f1.ttf) format("truetype")}` +
      `.a{border-image:url("/assets/slice-s1.png") 4}.b{border-image:url(./slice-s1.png) 4}` +
      `.c{background:url(data:image/png;base64,AAAA)}.d{background:url(/assets/gone.png)}`,
  );
  put("assets/slice-s1.png", 200);
  put("assets/face-f1.ttf", 4000);
  // the battle: a lazy chunk, its own CSS (which reuses the town's 9-slice and adds a texture), a map
  put("assets/replay-b2.js", `const css="assets/replay-b2.css";const tex="/assets/sand-t1.png";`);
  put("assets/replay-b2.css", `.r{background:url(/assets/sand-t1.png)}.s{border-image:url(/assets/slice-s1.png) 4}`);
  put("assets/sand-t1.png", 700);
  put("assets/replay-b2.js.map", 5000);
});

describe("measureBudget", () => {
  it("exposes the default limits", () => {
    expect(TOWN_LIMIT_BYTES).toBe(8_000_000);
    expect(BATTLE_LIMIT_BYTES).toBe(4_000_000);
  });
  it("counts html, referenced js and css, static imports, named images, and the town atlas", () => {
    const r = measureBudget(dist, atlas);
    const direct = size("index.html") + size("manifest.webmanifest") + size("assets/index-a1.js") + size("assets/index-a1.css") + size("assets/shared-c3.js") + size("assets/logo-q1.png") + 1000;
    expect(r.townBytes).toBe(direct + size("assets/slice-s1.png") + size("assets/face-f1.ttf"));
  });
  it("counts an image and a font loaded through CSS url(), each once, however often it is named", () => {
    const withCss = measureBudget(dist, atlas).townBytes;
    const css = size("assets/index-a1.css");
    // dropping the CSS file's own bytes and its two assets must lower the total by exactly those
    expect(withCss - css - size("assets/slice-s1.png") - size("assets/face-f1.ttf")).toBe(
      size("index.html") + size("manifest.webmanifest") + size("assets/index-a1.js") + size("assets/shared-c3.js") + size("assets/logo-q1.png") + 1000,
    );
  });
  it("counts lazy js, the css and images it loads, and the battle atlas, but not what the town has, nor maps", () => {
    const r = measureBudget(dist, atlas);
    expect(r.battleBytes).toBe(size("assets/replay-b2.js") + size("assets/replay-b2.css") + size("assets/sand-t1.png") + 500);
  });
  it("passes with the default limits", () => {
    expect(measureBudget(dist, atlas).findings).toEqual([]);
  });
  it("reports one error per exceeded limit", () => {
    const r = measureBudget(dist, atlas, { town: 10, battle: 10 });
    expect(r.findings.map((f) => [f.level, f.id]).sort()).toEqual([["error", "budget/battle"], ["error", "budget/town"]]);
    expect(measureBudget(dist, atlas, { town: 10, battle: 10_000_000 }).findings.map((f) => f.id)).toEqual(["budget/town"]);
  });
  it("throws when index.html is missing", () => {
    expect(() => measureBudget(join(dist, "assets"), atlas)).toThrow();
  });
});
