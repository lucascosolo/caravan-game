/**
 * Chunk 11 — budgets: the full-load scenario (16 attackers vs 8 posts vs all 28 fence
 * segments, 6 traps, 2 siege pieces, 180 s = 3600 ticks) resolves inside the time budget,
 * and its log is measured against chunk 13's 100 KB target. The measurement is REPORTED
 * (printed) and pinned loosely here; chunk 13 owns the format and may coalesce events.
 */
import { describe, expect, it } from "vitest";
import { resolve, type LogEvent } from "../src/index.js";
import { clone, fullLoadScenario } from "./fixtures.js";

describe("budgets (16 vs 8 vs 28 fences, 3600 ticks)", () => {
  it("resolves in under 100 ms (best of 7 after a warm-up run — the contention-free cost; the median under a parallel vitest load is reported too)", () => {
    const scenario = fullLoadScenario();
    resolve(clone(scenario)); // warm-up: JIT
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const out = resolve(clone(scenario));
      times.push(performance.now() - start);
      expect(out.ticks).toBe(3600);
    }
    times.sort((a, b) => a - b);
    const best = times[0]!;
    const median = times[3]!;
    process.stdout.write(`full-load resolve: best ${best.toFixed(1)} ms, median ${median.toFixed(1)} ms (runs ${times.map((t) => t.toFixed(0)).join(", ")})\n`);
    expect(best).toBeLessThan(100);
  });

  it("the fight is a real one: units die on both sides, traps fire and are nullified, fences break, posts chase", () => {
    const out = resolve(fullLoadScenario());
    const kinds: Record<string, number> = {};
    for (const e of out.log) kinds[e.k] = (kinds[e.k] ?? 0) + 1;
    expect(kinds["hit"]).toBeGreaterThan(50);
    expect(kinds["unit_died"]).toBeGreaterThan(2);
    // Sixteen raiders against eight posts: the posts are wiped, the raiders are bloodied.
    expect(out.units.some((u) => u.side === "defender" && !u.alive)).toBe(true);
    expect(out.units.some((u) => u.side === "attacker" && u.hp < u.maxHp)).toBe(true);
    expect((kinds["trap_fired"] ?? 0) + (kinds["trap_nullified"] ?? 0)).toBeGreaterThan(0);
    expect(kinds["trap_nullified"]).toBeGreaterThan(0); // bridging planks vs groundwork
    expect(kinds["fence_broken"]).toBeGreaterThan(0);
    expect(kinds["aggro"]).toBeGreaterThan(0);
  });

  it("measures the log against the 100 KB budget and reports the breakdown by event kind", () => {
    const out = resolve(fullLoadScenario());
    const bytes = JSON.stringify(out.log).length;
    const byKind: Record<string, { n: number; bytes: number }> = {};
    for (const e of out.log) {
      const k = (e as LogEvent).k;
      const entry = (byKind[k] ??= { n: 0, bytes: 0 });
      entry.n++;
      entry.bytes += JSON.stringify(e).length;
    }
    const lines = Object.entries(byKind)
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([k, v]) => `  ${k.padEnd(15)} ${String(v.n).padStart(6)} events ${String(v.bytes).padStart(8)} B`);
    process.stdout.write(`full-load log: ${bytes} B (${(bytes / 1024).toFixed(1)} KB) over ${out.ticks} ticks, ${out.log.length} events\n${lines.join("\n")}\n`);
    // Pinned loosely so a regression that doubles the log is caught; the 100 KB target itself is chunk 13's call.
    expect(bytes).toBeLessThan(600 * 1024);
  });
});
