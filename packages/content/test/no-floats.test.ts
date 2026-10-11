/**
 * No float reaches the sim-facing content structures, and no float literal appears in the
 * content source (chunk 03 definition of done; GUARDRAILS §1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AFFINITY_MATRIX, CONTENT, FIXED_POINT_SCALE, REGIONS, TUNABLES, fp, fpMilli, fpMul, fpRatio, scaleInt } from "../src/index.js";

function collectNumbers(value: unknown, path: string, out: { path: string; value: number }[]): void {
  if (typeof value === "number") out.push({ path, value });
  else if (Array.isArray(value)) value.forEach((v, i) => collectNumbers(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collectNumbers(v, `${path}.${k}`, out);
}

describe("no floats in exported data", () => {
  it("every number in CONTENT, TUNABLES, REGIONS and the affinity matrix is a safe integer", () => {
    const found: { path: string; value: number }[] = [];
    collectNumbers(CONTENT, "CONTENT", found);
    collectNumbers(TUNABLES, "TUNABLES", found);
    collectNumbers(REGIONS, "REGIONS", found);
    collectNumbers(AFFINITY_MATRIX, "AFFINITY_MATRIX", found);
    expect(found.length).toBeGreaterThan(300);
    const bad = found.filter((n) => !Number.isSafeInteger(n.value));
    expect(bad).toEqual([]);
  });

  it("fixed-point helpers only ever produce integers and refuse non-integer input", () => {
    expect(fp(3)).toBe(3 * FIXED_POINT_SCALE);
    expect(fpMilli(1500)).toBe(1536);
    expect(fpMilli(800)).toBe(819);
    expect(fpRatio(5, 3)).toBe(1706);
    expect(fpMul(fpMilli(1500), fp(2))).toBe(3072);
    expect(scaleInt(100, fpMilli(1250))).toBe(125);
    expect(scaleInt(100, fpMilli(800))).toBe(79); // floor of 100 × 819/1024 — the documented rounding
    expect(() => fp(1.5)).toThrow();
    expect(() => fpMilli(0.5)).toThrow();
    expect(() => fpRatio(1, 0)).toThrow();
  });

  it("the merge table is the authored source, not a runtime computation", () => {
    expect(TUNABLES.MERGE_STAT_MULT_BY_LEVEL).toEqual([0, 1024, 1638, 2621, 4194, 6711]);
  });
});

describe("no float literal in content source", () => {
  // Same regex family as the resolver's lint rule: 1.5  .5  1.  1e3  — not hex, not plain ints.
  const FLOAT_LITERAL = /(?<![\w.])(?:\d[\d_]*\.\d*|\.\d+)(?:[eE][-+]?\d+)?(?![\w.])|(?<![\w.])\d[\d_]*[eE][-+]?\d+(?![\w.])/;

  function stripCommentsAndStrings(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
  }

  it("packages/content/src contains no float literal, bare division, '**' or banned Math call", () => {
    const dir = join(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const code = stripCommentsAndStrings(readFileSync(join(dir, file), "utf8"));
      code.split("\n").forEach((line, i) => {
        const where = `${file}:${i + 1}`;
        if (FLOAT_LITERAL.test(line)) offenders.push(`${where} float literal: ${line.trim()}`);
        if (/\*\*/.test(line)) offenders.push(`${where} '**': ${line.trim()}`);
        if (/Math\.(random|sin|cos|tan|atan2?|exp|pow|sqrt|log|fround)\b/.test(line)) offenders.push(`${where} banned Math call: ${line.trim()}`);
        if (/\bparseFloat\b|\btoFixed\b/.test(line)) offenders.push(`${where} float API: ${line.trim()}`);
        // Division only inside Math.trunc(...) / Math.floor(...) on the same line.
        if (/[^/*]\/[^/*]/.test(line) && !/Math\.(trunc|floor)\(/.test(line)) offenders.push(`${where} bare division: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
