/**
 * Budgets — time (chunk 11) and the replay's size (chunk 13 LOG_SIZE_BUDGET: 100 KB per raid,
 * compressed). Measured, not assumed; every number is printed.
 *
 * Three full-load fights (16 raiders, 8 posts, all 28 segments, 6 traps, 2 siege — twice the
 * PARTY_SLOT_CAP of 8):
 *   - `fullLoadScenario` as `resolve` plays it (chunk 13 end conditions: it ends at the first
 *     arrival);
 *   - the same roster forced through all 3600 ticks (runToCap) — the chunk 10/11/12 QA figure,
 *     ≈ 125 KB of JSON objects before chunk 13's format;
 *   - `fullLoadFullLength`: every raider and post unkillable, every raider on `nearest` —
 *     180 s of blows, the most a full-load fight can log.
 * The stored form is the LOG_FORMAT replay (src/replay.ts) serialized as JSON and gzipped.
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeReplay, readReplay, resolve, type LogEvent, type ResolveOutput } from "../src/index.js";
import { clone, fullLoadFullLength, fullLoadScenario, runToCap, scenarios } from "./fixtures.js";

const BUDGET = 100 * 1024;

function measure(out: ResolveOutput): { raw: number; gz: number; keyframes: number; oldJson: number } {
  const replay = encodeReplay(out);
  const text = JSON.stringify(replay);
  return {
    raw: Buffer.byteLength(text),
    gz: gzipSync(text, { level: 9 }).length,
    keyframes: replay.events.filter((r) => r[1] === "kf").reduce((a, r) => a + JSON.stringify(r).length + 1, 0),
    oldJson: JSON.stringify(out.log).length,
  };
}

describe("budgets", () => {
  it("time: the full-length full-load fight resolves in under 300 ms (best of 5 after a warm-up; the realistic full load in under 100 ms)", () => {
    const time = (f: () => unknown, runs: number) => {
      f();
      const times: number[] = [];
      // CPU time of this process (vitest runs each file in its own forked worker), not wall time:
      // the bound is the resolver's cost, and a runner loaded by other test files (QA-13 S6) must
      // not fail it. The bounds are unchanged.
      for (let i = 0; i < runs; i++) {
        const start = process.cpuUsage();
        f();
        const used = process.cpuUsage(start);
        times.push((used.user + used.system) / 1000);
      }
      return times.sort((a, b) => a - b);
    };
    const full = time(() => resolve(clone(fullLoadFullLength())), 5);
    // Best of 15 for the ~0.1 s fights (QA-13 S6: the suite runs this file beside the 100× harness on
    // every core; the minimum of more short runs is the load-robust estimate, the bound is unchanged).
    const real = time(() => resolve(clone(fullLoadScenario())), 15);
    const cap = time(() => runToCap(clone(fullLoadScenario())), 15);
    process.stdout.write(`resolve time: full-length full load best ${full[0]!.toFixed(1)} ms; full load (ends at arrival) best ${real[0]!.toFixed(1)} ms; full load forced to 3600 ticks best ${cap[0]!.toFixed(1)} ms\n`);
    expect(full[0]!).toBeLessThan(300);
    expect(real[0]!).toBeLessThan(100);
    expect(cap[0]!).toBeLessThan(100);
  });

  it("the full-length full-load fight is a real one: every one of 3600 ticks, both sides swinging all fight, abilities firing, a stalemate", () => {
    const out = resolve(fullLoadFullLength());
    expect(out.ticks).toBe(3600);
    expect(out.outcome.kind).toBe("stalemate");
    const kinds: Record<string, number> = {};
    for (const e of out.log) kinds[e.k] = (kinds[e.k] ?? 0) + 1;
    expect(kinds["hit"]).toBeGreaterThan(3000);
    expect(kinds["ability"]).toBeGreaterThan(100);
    const lastHit = out.log.filter((e) => e.k === "hit").pop()!;
    expect(lastHit.t).toBeGreaterThan(3500);
  });

  it("size: every full-load replay fits the 100 KB budget compressed, the realistic and forced-to-cap ones uncompressed too; keyframes shrink ~20×", () => {
    const rows: [string, ResolveOutput][] = [
      ["full load, resolved (ends at the first arrival)", resolve(fullLoadScenario())],
      ["full load, forced to 3600 ticks", runToCap(fullLoadScenario())],
      ["full load, unkillable, full length", resolve(fullLoadFullLength())],
    ];
    const lines: string[] = [];
    for (const [label, out] of rows) {
      const m = measure(out);
      const byKind: Record<string, number> = {};
      for (const e of out.log) byKind[(e as LogEvent).k] = (byKind[(e as LogEvent).k] ?? 0) + 1;
      lines.push(`  ${label}: ${out.ticks} ticks, ${out.log.length} events — stored ${m.raw} B raw (${(m.raw / 1024).toFixed(1)} KB), ${m.gz} B gzip (${(m.gz / 1024).toFixed(1)} KB); keyframes ${m.keyframes} B; the same log as chunk 12's JSON objects ${m.oldJson} B`);
      expect(m.gz, label).toBeLessThan(BUDGET);
      // The stored form is a complete, readable replay. (Not the forced one: runToCap plays on past
      // arrivals that end a real fight, and the reader rightly refuses a log whose outcome the rows contradict.)
      if (!label.includes("forced")) expect(readReplay(JSON.parse(JSON.stringify(encodeReplay(out)))).events.length).toBe(out.log.length);
      else expect(() => readReplay(JSON.parse(JSON.stringify(encodeReplay(out))))).toThrow(/reached the core before the last tick/);
    }
    process.stdout.write(`replay size (LOG_SIZE_BUDGET ${BUDGET} B compressed):\n${lines.join("\n")}\n`);
    const forced = measure(rows[1]![1]);
    expect(forced.raw).toBeLessThan(BUDGET); // was ≈ 125 KB (95 KB of keyframes) in chunk 12's format
    expect(forced.keyframes * 20).toBeLessThan(95_000 * 1.2);
    expect(measure(rows[0]![1]).raw).toBeLessThan(BUDGET);
  });

  it("size: every corpus fight's replay fits the budget compressed (largest reported)", () => {
    let worst = { name: "", raw: 0, gz: 0 };
    for (const { name, input } of scenarios()) {
      const m = measure(resolve(clone(input)));
      expect(m.gz, name).toBeLessThan(BUDGET);
      if (m.gz > worst.gz) worst = { name, raw: m.raw, gz: m.gz };
    }
    process.stdout.write(`largest corpus replay: ${worst.name} — ${worst.raw} B raw, ${worst.gz} B gzip\n`);
  });
});
