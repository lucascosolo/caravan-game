/**
 * No float in the model or its serialization (chunk 07 definition of done; GUARDRAILS §1).
 * Same source rules as @caravan/content: no float literal, no bare division, no '**', no
 * banned Math call, no float API, in packages/circle/src.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEncounterOutcome, serializeFormation, serializeManifest, toBattlefield } from "../src/index.js";
import { arrange, fullPack } from "./fixtures.js";

function collectNumbers(value: unknown, path: string, out: { path: string; value: number }[]): void {
  if (typeof value === "number") out.push({ path, value });
  else if (Array.isArray(value)) value.forEach((v, i) => collectNumbers(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collectNumbers(v, `${path}.${k}`, out);
}

describe("no floats in the model", () => {
  it("every number in a manifest, a formation and a battlefield is a safe integer — before and after attrition", () => {
    const m1 = fullPack();
    const m2 = applyEncounterOutcome(m1, { units: [{ ref: "u-rider", hp: 7 }], spentTraps: ["t0"], fences: [{ ref: "f0", hp: 13 }] });
    const f = arrange(m2, 5);
    const b = toBattlefield(m2, f);
    const found: { path: string; value: number }[] = [];
    collectNumbers(m2, "manifest", found);
    collectNumbers(f, "formation", found);
    collectNumbers(b, "battlefield", found);
    expect(found.length).toBeGreaterThan(400);
    expect(found.filter((n) => !Number.isSafeInteger(n.value))).toEqual([]);
  });

  it("serialized snapshots contain no fractional number", () => {
    const m = fullPack();
    const texts = [serializeManifest(m), serializeFormation(arrange(m))];
    for (const s of texts) {
      expect(/\d\.\d|[eE][-+]?\d/.test(s.replace(/"[^"]*"/g, ""))).toBe(false);
    }
  });
});

describe("no float literal in circle source", () => {
  const FLOAT_LITERAL = /(?<![\w.])(?:\d[\d_]*\.\d*|\.\d+)(?:[eE][-+]?\d+)?(?![\w.])|(?<![\w.])\d[\d_]*[eE][-+]?\d+(?![\w.])/;

  function stripCommentsAndStrings(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
  }

  it("packages/circle/src contains no float literal, bare division, '**', banned Math call or float API", () => {
    const dir = join(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const code = stripCommentsAndStrings(readFileSync(join(dir, file), "utf8"));
      code.split("\n").forEach((line, i) => {
        const where = `${file}:${i + 1}`;
        if (FLOAT_LITERAL.test(line)) offenders.push(`${where} float literal: ${line.trim()}`);
        if (/\*\*/.test(line)) offenders.push(`${where} '**': ${line.trim()}`);
        if (/Math\.(random|sin|cos|tan|atan2?|exp|pow|sqrt|log|fround|hypot)\b/.test(line)) offenders.push(`${where} banned Math call: ${line.trim()}`);
        if (/\bparseFloat\b|\btoFixed\b|\bDate\b|\bperformance\b/.test(line)) offenders.push(`${where} float/clock API: ${line.trim()}`);
        if (/[^/*]\/[^/*]/.test(line) && !/Math\.(trunc|floor)\(/.test(line)) offenders.push(`${where} bare division: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the source grep fires on a planted float, bare division and clock read", () => {
    const planted = ["const x = 1.5;", "const y = a / b;", "const t = Date.now();", "const r = Math.sqrt(4);"];
    for (const line of planted) {
      const hit =
        FLOAT_LITERAL.test(line) ||
        (/[^/*]\/[^/*]/.test(line) && !/Math\.(trunc|floor)\(/.test(line)) ||
        /\bDate\b/.test(line) ||
        /Math\.(random|sin|cos|tan|atan2?|exp|pow|sqrt|log|fround|hypot)\b/.test(line);
      expect(hit, line).toBe(true);
    }
  });
});
