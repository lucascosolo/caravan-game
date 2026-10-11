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
/**
 * PHASE-2 §36: one 180-second fight resolves in under 100 ms on the server, measured in CI over
 * the WHOLE golden corpus (`scenarios()`, the fights `pnpm determinism` pins byte-for-byte) and the
 * three full-load fights below. Operational, not balance: it bounds the resolver's cost, so it is
 * not in the tunables registry.
 *
 * WHERE THE BOUND IS ASSERTED. CPU time is not load-invariant: measured on 4 cores with
 * `pnpm determinism` running beside this file, the heaviest corpus fight (c13-full-load-full-length,
 * ~75-90 ms alone) read 103-137 ms of CPU — shared caches and SMT siblings slow the same
 * instructions. So the §36 bound itself (100 ms) is asserted by `pnpm perf:resolver`
 * (the resolver package's `budget` script: this file ALONE, RESOLVER_BUDGET_STRICT=1), a CI step of its own
 * after the parallel suite; inside the parallel `pnpm test` the same measurements run with a 2×
 * allowance, so a loaded runner cannot fail CI and a resolver that doubles its cost still does.
 *
 * Load-robust otherwise (QA-13 S6): process CPU time (user + system of this forked vitest worker),
 * not wall time; the minimum of several runs after a warm-up, with a GC before each; and the
 * corpus is timed in batches, one test each, so no synchronous block runs for more than a few
 * seconds.
 */
const RESOLVE_BUDGET_STRICT = process.env["RESOLVER_BUDGET_STRICT"] === "1";
/** The §36 budget. */
const RESOLVE_BUDGET_MS = 100;
/** What this run asserts: the budget alone (strict), or 2× it beside the rest of the suite. */
const RESOLVE_BOUND_MS = RESOLVE_BUDGET_STRICT ? RESOLVE_BUDGET_MS : 2 * RESOLVE_BUDGET_MS;
const BOUND_LABEL = RESOLVE_BUDGET_STRICT ? `${RESOLVE_BUDGET_MS} ms (strict, §36)` : `${RESOLVE_BOUND_MS} ms (2× the §36 ${RESOLVE_BUDGET_MS} ms: parallel suite; pnpm perf:resolver asserts ${RESOLVE_BUDGET_MS})`;
/**
 * Corpus timing: at least CORPUS_RUNS_MIN runs per fight after a warm-up, and up to CORPUS_RUNS_MAX
 * while the best is still above half the budget (only the few heavy fights). Measured under a
 * concurrent `pnpm determinism`: best of 3 let one collected-garbage run of the heaviest fight
 * read 137 ms against ~80 ms unloaded; best of up to 9, with a GC before every run, does not.
 */
const CORPUS_RUNS_MIN = 3;
const CORPUS_RUNS_MAX = 9;
const CORPUS_BATCH = 8;

/** `--expose-gc` (vitest.config.ts): collect before each timed run so one run never pays for the previous run's garbage. */
const collect: () => void = typeof (globalThis as { gc?: () => void }).gc === "function" ? (globalThis as unknown as { gc: () => void }).gc : () => {};

/** CPU milliseconds of `f` per run, after one warm-up call: `runs` runs, or up to `maxRuns` while the best is >= `until`. Sorted ascending. */
function cpuTimes(f: () => unknown, runs: number, maxRuns = runs, until = 0): number[] {
  f();
  const times: number[] = [];
  while (times.length < runs || (times.length < maxRuns && Math.min(...times) >= until)) {
    collect();
    const start = process.cpuUsage();
    f();
    const used = process.cpuUsage(start);
    times.push((used.user + used.system) / 1000);
  }
  return times.sort((a, b) => a - b);
}

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
  it(`time: the full-length full-load fight (180 s, the most a fight can log) and the realistic full loads each resolve in under ${BOUND_LABEL} of CPU (best of 5 / 15 after a warm-up)`, () => {
    const full = cpuTimes(() => resolve(clone(fullLoadFullLength())), 5);
    // Best of 15 for the shorter fights (QA-13 S6: the suite runs this file beside the 100× harness on
    // every core; the minimum of more short runs is the load-robust estimate).
    const real = cpuTimes(() => resolve(clone(fullLoadScenario())), 15);
    const cap = cpuTimes(() => runToCap(clone(fullLoadScenario())), 15);
    process.stdout.write(`resolve time (CPU, bound ${BOUND_LABEL}): full-length full load best ${full[0]!.toFixed(1)} ms; full load (ends at arrival) best ${real[0]!.toFixed(1)} ms; full load forced to 3600 ticks best ${cap[0]!.toFixed(1)} ms\n`);
    expect(full[0]!).toBeLessThan(RESOLVE_BOUND_MS);
    expect(real[0]!).toBeLessThan(RESOLVE_BOUND_MS);
    expect(cap[0]!).toBeLessThan(RESOLVE_BOUND_MS);
  });

  describe(`time: every golden-corpus fight resolves in under ${BOUND_LABEL} of CPU (PHASE-2 §36; best of ${CORPUS_RUNS_MIN}-${CORPUS_RUNS_MAX} after a warm-up)`, () => {
    const corpus = scenarios();
    const timed: { name: string; ticks: number; best: number }[] = [];
    const batches: (typeof corpus)[] = [];
    for (let i = 0; i < corpus.length; i += CORPUS_BATCH) batches.push(corpus.slice(i, i + CORPUS_BATCH));
    it.each(batches.map((b, i) => [i + 1, b] as const))("batch %i", (_n, batch) => {
      for (const { name, input } of batch) {
        let ticks = 0;
        const best = cpuTimes(() => {
          ticks = resolve(clone(input)).ticks;
        }, CORPUS_RUNS_MIN, CORPUS_RUNS_MAX, RESOLVE_BUDGET_MS / 2)[0]!;
        timed.push({ name, ticks, best });
        expect(best, `${name} (${ticks} ticks) took ${best.toFixed(1)} ms of CPU`).toBeLessThan(RESOLVE_BOUND_MS);
      }
    });
    it("covers the whole corpus, including full-length (180 s) fights, and reports the slowest", () => {
      expect(timed.length).toBe(corpus.length);
      const fullLength = timed.filter((t) => t.ticks === 3600);
      expect(fullLength.length).toBeGreaterThan(0);
      const slowest = [...timed].sort((a, b) => b.best - a.best).slice(0, 3);
      const mean = timed.reduce((a, t) => a + t.best, 0) / timed.length;
      process.stdout.write(
        `corpus resolve time (CPU, bound ${BOUND_LABEL}, ${timed.length} fights, ${fullLength.length} of them full-length): mean ${mean.toFixed(1)} ms; slowest ${slowest.map((t) => `${t.name} ${t.best.toFixed(1)} ms (${t.ticks} ticks)`).join(", ")}; slowest full-length ${Math.max(...fullLength.map((t) => t.best)).toFixed(1)} ms\n`,
      );
    });
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
