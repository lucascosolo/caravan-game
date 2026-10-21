import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BATTLE_LIMIT_BYTES, TOWN_LIMIT_BYTES, measureBudget } from "../src/budget.ts";

const dist = fileURLToPath(new URL("./fixtures/dist", import.meta.url));
const size = (p: string) => statSync(join(dist, p)).size;
const atlas = { town: 1000, battle: 500 };

describe("measureBudget", () => {
  it("exposes the default limits", () => {
    expect(TOWN_LIMIT_BYTES).toBe(8_000_000);
    expect(BATTLE_LIMIT_BYTES).toBe(4_000_000);
  });
  it("sums index.html, referenced assets and the town atlas for the town", () => {
    const r = measureBudget(dist, atlas);
    expect(r.townBytes).toBe(size("index.html") + size("assets/index-a1.js") + size("assets/index-a1.css") + 1000);
  });
  it("counts unreferenced js plus the battle atlas for the battle, never maps", () => {
    const r = measureBudget(dist, atlas);
    expect(r.battleBytes).toBe(size("assets/replay-b2.js") + 500);
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
