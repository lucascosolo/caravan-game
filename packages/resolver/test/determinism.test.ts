/**
 * The determinism harness (GUARDRAILS §1; chunk 10 started it, chunk 13 completes it):
 *   - every corpus scenario resolved 100× produces a byte-identical serialized output;
 *   - every corpus scenario matches its checked-in GOLDEN LOG (packages/resolver/golden), so a
 *     resolver change that alters any replay fails here until the goldens are regenerated —
 *     and the CI gate (root scripts/determinism.mjs) refuses regenerated goldens without a
 *     RESOLVER_VERSION bump;
 *   - the corpus is at least 50 fights and covers what chunk 13 lists (gapped and sealed rings,
 *     all three attacker stances and all three post stances, siege matched and mismatched,
 *     all six archetypes, all three end conditions, the chunk 10–12 boundary fixtures);
 *   - every numeric field of the simulation state is a safe integer after every tick;
 *   - the output contains no non-integer number and nothing account-shaped;
 *   - re-ordered input is byte-identical; the input is never mutated.
 * Cross-process: scripts/determinism.mjs runs test/harness/driver.ts in separate Node
 * processes and compares their golden hashes with each other and with the files.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ABILITY_ARCHETYPES, PERIMETER_SEGMENTS, RESOLVER_VERSION, endOfTick, initialState, normalizeInput, readReplay, resolve, runTick, type LogEvent, type SimState } from "../src/index.js";
import { clone, scenarios } from "./fixtures.js";
import { GOLDEN_SUFFIX, WORK_COUNTERS_FILE, goldenText } from "./golden.js";

const GOLDEN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "golden");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

function nonIntegers(value: unknown, where: string, out: string[]): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) out.push(`${where} = ${String(value)}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => nonIntegers(v, `${where}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) nonIntegers(v, `${where}.${k}`, out);
}

function stateNumbers(state: SimState): unknown {
  // Everything mutable the loop touches, including the typed-array grid.
  return {
    tick: state.tick,
    units: state.units.map((u) => ({ ...u, waypoints: u.waypoints, unreachable: u.unreachable })),
    fences: state.fences,
    traps: state.traps,
    grid: Array.from(state.grid),
  };
}

/**
 * QA-13 S6: the 100× loop is split per scenario AND into RUN_BATCHES batches, one `it` each, each
 * starting with a macrotask yield (yieldToEventLoop), so no synchronous block runs for more than a
 * few seconds even on a loaded runner (one `it` over all 72
 * fights × 100 blocked the worker's event loop past vitest's RPC timeout: "Timeout calling
 * onTaskUpdate", exit 1 with every test green). What is checked is unchanged: 100 resolutions of
 * every scenario, every one byte-identical to the first.
 */
const RUNS = 100;
/**
 * Between tests vitest only awaits promises (microtasks), so a file of synchronous tests never
 * lets the worker's event loop run: the reply to its "onTaskUpdate" RPC sits unread until the
 * whole file is done, and past 60 s (a loaded runner) the RPC times out and the run exits 1 with
 * every test green — the QA-13 S6 failure. A macrotask yield before each batch lets it through.
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const RUN_BATCHES = 4;
const reference = new Map<string, string>();
const runBatches = scenarios().flatMap(({ name, input }) =>
  Array.from({ length: RUN_BATCHES }, (_, b) => ({ name, input, from: Math.floor((b * RUNS) / RUN_BATCHES), to: Math.floor(((b + 1) * RUNS) / RUN_BATCHES) })),
);

describe("determinism harness: every corpus scenario resolved 100× to a byte-identical output", () => {
  it.each(runBatches)("$name runs $from to $to", async ({ name, input, from, to }) => {
    await yieldToEventLoop();
    let first = reference.get(name);
    if (first === undefined) {
      first = JSON.stringify(resolve(clone(input)));
      reference.set(name, first);
      expect(first.length).toBeGreaterThan(300);
    }
    for (let i = Math.max(from, 1); i < to; i++) {
      const again = JSON.stringify(resolve(clone(input)));
      expect(again === first, `${name}: run ${i} diverged`).toBe(true);
    }
  });

  it("ran every scenario 100 times (every batch of every scenario)", () => {
    expect(runBatches).toHaveLength(scenarios().length * RUN_BATCHES);
    expect(runBatches.filter((b) => b.name === scenarios()[0]!.name).map((b) => [b.from, b.to])).toEqual([[0, 25], [25, 50], [50, 75], [75, 100]]);
    expect(reference.size).toBe(scenarios().length);
  });
});

describe("determinism harness", () => {
  it("every corpus scenario matches its checked-in golden log, and the golden directory holds nothing else", () => {
    if (UPDATE) mkdirSync(GOLDEN_DIR, { recursive: true });
    const names = scenarios().map((s) => s.name);
    expect(new Set(names).size, "scenario names are unique").toBe(names.length);
    const changed: string[] = [];
    for (const { name, input } of scenarios()) {
      const text = goldenText(name, resolve(clone(input)));
      const file = path.join(GOLDEN_DIR, `${name}${GOLDEN_SUFFIX}`);
      if (UPDATE) {
        if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
        continue;
      }
      expect(existsSync(file), `${name}: no golden log at ${file} (UPDATE_GOLDEN=1 writes one — and bump RESOLVER_VERSION if the resolver changed)`).toBe(true);
      if (readFileSync(file, "utf8") !== text) changed.push(name);
    }
    expect(changed, "golden logs differ: the resolver now resolves these fights differently. If intended, bump RESOLVER_VERSION and regenerate with UPDATE_GOLDEN=1").toEqual([]);
    const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(GOLDEN_SUFFIX));
    expect(files.map((f) => f.slice(0, -GOLDEN_SUFFIX.length)).sort()).toEqual([...names].sort());
    // PHASE-2 §36: and the work counters (test/budget.test.ts), nothing else.
    expect(readdirSync(GOLDEN_DIR).filter((f) => !f.endsWith(GOLDEN_SUFFIX))).toEqual([WORK_COUNTERS_FILE]);
  });

  it("every golden file is a readable replay of the current resolver version, and decodes to the fight's log", () => {
    for (const { name, input } of scenarios()) {
      const golden = JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}${GOLDEN_SUFFIX}`), "utf8")) as { resolverVersion: number; replay: unknown };
      expect(golden.resolverVersion).toBe(RESOLVER_VERSION);
      const replay = readReplay(golden.replay);
      expect(JSON.stringify(replay.events), name).toBe(JSON.stringify(resolve(clone(input)).log));
    }
  });

  it("the corpus: ≥ 50 fights covering every stance, siege matched and mismatched, all six archetypes, all three end conditions, gapped and sealed rings", () => {
    const all = scenarios();
    expect(all.length).toBeGreaterThanOrEqual(50);
    const kinds = new Set<string>();
    const fired = new Set<string>();
    const attackerStances = new Set<string>();
    const postStances = new Set<string>();
    let sealed = 0;
    let gapped = 0;
    let open = 0;
    let siegeMatched = 0;
    let siegeMismatched = 0;
    let capTickEnds = 0;
    for (const { input } of all) {
      const out = resolve(clone(input));
      kinds.add(out.outcome.kind);
      if (out.outcome.kind !== "stalemate" && out.ticks === out.tickCap) capTickEnds++;
      for (const e of out.log) if (e.k === "ability") fired.add(`${out.units[e.u]!.side}:${e.a}`);
      input.party.units.forEach((u) => attackerStances.add(u.stance));
      input.battlefield.posts.forEach((p) => postStances.add(p.stance));
      const nf = input.battlefield.fences.length;
      if (nf === PERIMETER_SEGMENTS) sealed++;
      else if (nf > 0) gapped++;
      else open++;
      for (const s of input.party.siege) {
        const hits = s.counters.kind === "fence" ? input.battlefield.fences.some((f) => f.category === s.counters.category) : input.battlefield.traps.some((t) => t.category === s.counters.category);
        if (hits) siegeMatched++;
        else siegeMismatched++;
      }
    }
    expect([...kinds].sort()).toEqual(["caravan_held", "caravan_overrun", "stalemate"]);
    for (const a of ABILITY_ARCHETYPES) expect(fired, `attacker ${a}`).toContain(`attacker:${a}`);
    for (const a of ABILITY_ARCHETYPES.filter((x) => x !== "structure_breaker")) expect(fired, `defender ${a}`).toContain(`defender:${a}`);
    expect([...attackerStances].sort()).toEqual(["core", "nearest", "traps"]);
    expect([...postStances].sort()).toEqual(["guard", "hold", "reserve"]);
    expect(sealed).toBeGreaterThan(3);
    expect(gapped).toBeGreaterThan(3);
    expect(open).toBeGreaterThan(3);
    expect(siegeMatched).toBeGreaterThan(2);
    expect(siegeMismatched).toBeGreaterThan(1);
    expect(capTickEnds, "an overrun or a wipe on the cap tick itself").toBeGreaterThanOrEqual(2);
  });

  it.each(scenarios())("every state field is a safe integer after every tick: $name", async ({ name, input }) => {
    await yieldToEventLoop();
    const state = initialState(normalizeInput(clone(input)));
    const log: LogEvent[] = [];
    const bad: string[] = [];
    nonIntegers(stateNumbers(state), `${name}@init`, bad);
    for (; state.tick < state.tickCap; state.tick++) {
      runTick(state, log);
      const end = endOfTick(state);
      nonIntegers(stateNumbers(state), `${name}@${state.tick}`, bad);
      if (bad.length || end !== null) break;
    }
    nonIntegers(log, `${name}.log`, bad);
    expect(bad).toEqual([]);
  });

  it("the output carries no non-integer number and nothing that smells of an account", () => {
    for (const { input } of scenarios()) {
      const out = resolve(clone(input));
      const bad: string[] = [];
      nonIntegers(out, "output", bad);
      expect(bad).toEqual([]);
      const keys = new Set<string>();
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            keys.add(k);
            walk(x);
          }
        }
      };
      walk(out);
      expect([...keys].filter((k) => /account|coin|loot|purchase|entitlement|paying|billing/i.test(k))).toEqual([]);
    }
  });

  it("the input is never mutated by resolution (a standing party is a template)", () => {
    for (const { input } of scenarios()) {
      const frozen = JSON.stringify(input);
      resolve(input);
      expect(JSON.stringify(input)).toBe(frozen);
    }
  });
});
