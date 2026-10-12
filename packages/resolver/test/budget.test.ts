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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RESOLVER_VERSION, encodeReplay, readReplay, resolve, type LogEvent, type ResolveOutput } from "../src/index.js";
import { clone, fullLoadFullLength, fullLoadScenario, runToCap, scenarios } from "./fixtures.js";
import { WORK_COUNTERS_FILE, workCountersText } from "./golden.js";

const BUDGET = 100 * 1024;
/**
 * PHASE-2 §36: one 180-second fight resolves in under 100 ms on the server. Operational, not
 * balance, so not in the tunables registry. Since QA-36 S3 it is gated in three layers, none of
 * which a loaded or slower CI runner can fail by noise:
 *
 *   1. WORK (blocking, exact). The resolver counts its own work in integers (`ResolveOutput.work`:
 *      ticks, unit-ticks, A* searches, cells A* expanded — src/state.ts WorkCounters; never logged,
 *      never read by the simulation). Every golden-corpus fight's counts are pinned in
 *      packages/resolver/golden/work-counters.json, written by `UPDATE_GOLDEN=1` together with the
 *      golden logs and carrying RESOLVER_VERSION, so the golden gate (scripts/golden-gate.mjs)
 *      demands a version bump to change them. An algorithmic regression — A* blowing up, a loop
 *      gone quadratic — changes these numbers on any machine, with zero noise. A balance change
 *      regenerates them with the goldens.
 *   2. TIME, RELATIVE (blocking, generous). In this process, interleaved, the heaviest corpus fight
 *      against a fixed integer reference workload (`referenceWork`, no resolver code): the ratio of
 *      their best CPU times must stay ≤ RELATIVE_MAX. Machine speed and most contention cancel.
 *   3. TIME, ABSOLUTE (report only). Every corpus fight's best CPU time and the 100 ms budget are
 *      printed (MET / EXCEEDED); `pnpm perf:resolver` runs this file alone for a clean number. The
 *      absolute bound is asserted only on a dedicated perf host (RESOLVER_BUDGET_STRICT=1).
 *
 * Measured before QA-36: run alone on a 4-core host, the heaviest fight (c13-full-load-full-length)
 * read 63-117 ms of CPU across runs and even within one run — noise (±30 %) larger than the margin.
 */
const RESOLVE_BUDGET_MS = 100;
/** A dedicated perf host only: also ASSERT the absolute budget. */
const RESOLVE_BUDGET_STRICT = process.env["RESOLVER_BUDGET_STRICT"] === "1";
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";
const WORK_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "golden", WORK_COUNTERS_FILE);
/**
 * Layer 2's bound. Calibrated 2026-10-12 on a 4-core host: heaviest fight / reference read 4.0-5.9
 * (alone and beside `pnpm determinism`, load average ~5); 12 is ~2.5× the typical 4.5. Generous on purpose: it is there to catch the resolver
 * getting ~2.5× slower relative to plain integer work, which layer 1 cannot see (a
 * constant-factor slowdown with the same counts).
 */
const RELATIVE_MAX = 12;
/** Runs per fight after a warm-up; the best counts (a GC before each, `--expose-gc`). */
const CORPUS_RUNS = 3;
const CORPUS_BATCH = 8;

/** `--expose-gc` (vitest.config.ts): collect before each timed run so one run never pays for the previous run's garbage. */
const collect: () => void = typeof (globalThis as { gc?: () => void }).gc === "function" ? (globalThis as unknown as { gc: () => void }).gc : () => {};

/** CPU milliseconds of one call of `f`. */
function cpuOnce(f: () => unknown): number {
  collect();
  const start = process.cpuUsage();
  f();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** Best CPU milliseconds of `f` over `runs` runs after one warm-up call. */
function cpuBest(f: () => unknown, runs: number): number {
  f();
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, cpuOnce(f));
  return best;
}

/** Layer 2's yardstick: fixed integer work (an xorshift walk over a typed array), ~20 ms on the calibration host. No resolver code. */
function referenceWork(): number {
  const a = new Int32Array(4096);
  let x = 0x2545f491;
  for (let i = 0; i < 12_000_000; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const k = x & 4095;
    a[k] = (a[k]! + (x | 0)) | 0;
  }
  return a[17]!;
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

type Work = ResolveOutput["work"];

describe("budgets", () => {
  it("work (layer 1, blocking): every golden-corpus fight's integer work counts equal the pinned ones (golden/work-counters.json)", () => {
    const work: Record<string, Work> = {};
    for (const { name, input } of scenarios()) {
      const a = resolve(clone(input)).work;
      expect(resolve(clone(input)).work, `${name}: work counts are deterministic`).toEqual(a);
      work[name] = a;
    }
    const text = workCountersText(RESOLVER_VERSION, work);
    if (UPDATE) {
      if (!existsSync(WORK_FILE) || readFileSync(WORK_FILE, "utf8") !== text) writeFileSync(WORK_FILE, text);
      return;
    }
    expect(existsSync(WORK_FILE), `no ${WORK_FILE}: UPDATE_GOLDEN=1 writes it with the golden logs`).toBe(true);
    const pinned = JSON.parse(readFileSync(WORK_FILE, "utf8")) as { resolverVersion: number; fights: Record<string, Work> };
    expect(pinned.resolverVersion, "work-counters.json carries the current RESOLVER_VERSION").toBe(RESOLVER_VERSION);
    const changed = Object.keys(work).filter((n) => JSON.stringify(work[n]) !== JSON.stringify(pinned.fights[n]));
    const detail = changed.slice(0, 5).map((n) => `${n}: pinned ${JSON.stringify(pinned.fights[n])} → now ${JSON.stringify(work[n])}`).join("; ");
    expect(changed, `the resolver now does different work on these fights (${detail}). If intended, bump RESOLVER_VERSION and regenerate with UPDATE_GOLDEN=1`).toEqual([]);
    expect(Object.keys(pinned.fights).sort()).toEqual(Object.keys(work).sort());
    const heaviest = Object.entries(work).sort((x, y) => y[1].pathExpansions - x[1].pathExpansions)[0]!;
    process.stdout.write(`work counters: ${Object.keys(work).length} fights pinned; most A* expansions ${heaviest[0]} ${heaviest[1].pathExpansions} in ${heaviest[1].pathSearches} searches over ${heaviest[1].ticks} ticks\n`);
  });

  it(`time, relative (layer 2, blocking): the heaviest corpus fight costs ≤ ${RELATIVE_MAX}× a fixed integer reference workload, timed interleaved in this process`, () => {
    const heavy = scenarios().find((s) => s.name === "c13-full-load-full-length")!;
    expect(heavy, "the corpus's full-length full-load fight").toBeDefined();
    const run = () => resolve(clone(heavy.input));
    run();
    referenceWork();
    let bestFight = Infinity;
    let bestRef = Infinity;
    for (let i = 0; i < 5; i++) {
      bestRef = Math.min(bestRef, cpuOnce(referenceWork));
      bestFight = Math.min(bestFight, cpuOnce(run));
    }
    const ratio = bestFight / bestRef;
    process.stdout.write(`relative resolve time: ${heavy.name} best ${bestFight.toFixed(1)} ms / reference best ${bestRef.toFixed(1)} ms = ${ratio.toFixed(2)} (bound ${RELATIVE_MAX})\n`);
    expect(ratio).toBeLessThan(RELATIVE_MAX);
  });

  describe(`time, absolute (layer 3, ${RESOLVE_BUDGET_STRICT ? "asserted: RESOLVER_BUDGET_STRICT=1" : "reported"}): every golden-corpus fight's CPU time against the ${RESOLVE_BUDGET_MS} ms budget (best of ${CORPUS_RUNS})`, () => {
    const corpus = scenarios();
    const timed: { name: string; ticks: number; best: number }[] = [];
    const batches: (typeof corpus)[] = [];
    for (let i = 0; i < corpus.length; i += CORPUS_BATCH) batches.push(corpus.slice(i, i + CORPUS_BATCH));
    it.each(batches.map((b, i) => [i + 1, b] as const))("batch %i", (_n, batch) => {
      for (const { name, input } of batch) {
        let ticks = 0;
        const best = cpuBest(() => {
          ticks = resolve(clone(input)).ticks;
        }, CORPUS_RUNS);
        timed.push({ name, ticks, best });
        if (RESOLVE_BUDGET_STRICT) expect(best, `${name} (${ticks} ticks) took ${best.toFixed(1)} ms of CPU`).toBeLessThan(RESOLVE_BUDGET_MS);
      }
    });
    it("covers the whole corpus, including full-length (180 s) fights, and reports the budget", () => {
      expect(timed.length).toBe(corpus.length);
      const fullLength = timed.filter((t) => t.ticks === 3600);
      expect(fullLength.length).toBeGreaterThan(0);
      const slowest = [...timed].sort((a, b) => b.best - a.best).slice(0, 3);
      const mean = timed.reduce((a, t) => a + t.best, 0) / timed.length;
      const worst = slowest[0]!;
      process.stdout.write(
        `corpus resolve time (CPU, ${timed.length} fights, ${fullLength.length} full-length): mean ${mean.toFixed(1)} ms; slowest ${slowest.map((t) => `${t.name} ${t.best.toFixed(1)} ms (${t.ticks} ticks)`).join(", ")} — §36 budget ${RESOLVE_BUDGET_MS} ms ${worst.best < RESOLVE_BUDGET_MS ? "MET" : "EXCEEDED"} on this host (${((1 - worst.best / RESOLVE_BUDGET_MS) * 100).toFixed(0)} % margin)\n`,
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
