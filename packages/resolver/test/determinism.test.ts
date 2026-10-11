/**
 * Determinism harness, chunk 10 part (GUARDRAILS §1; chunk 13 completes it with golden
 * logs and a 50-scenario corpus):
 *   - the same input resolved 100× produces a byte-identical serialized output;
 *   - every numeric field of the simulation state is a safe integer after every tick;
 *   - the output contains no non-integer number anywhere;
 *   - re-ordered input is byte-identical (also in movement.test.ts).
 * Cross-process: scripts/determinism.mjs runs test/harness/driver.ts in two separate Node
 * processes and compares their hashes with each other (and `pnpm determinism` at the root
 * calls it in CI).
 */
import { describe, expect, it } from "vitest";
import { initialState, normalizeInput, resolve, runTick, type LogEvent, type SimState } from "../src/index.js";
import { clone, scenarios } from "./fixtures.js";

function nonIntegers(value: unknown, path: string, out: string[]): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) out.push(`${path} = ${String(value)}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => nonIntegers(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) nonIntegers(v, `${path}.${k}`, out);
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

describe("determinism harness (chunk 10)", () => {
  it("resolves every fixture scenario 100× to a byte-identical output", () => {
    for (const { name, input } of scenarios()) {
      const first = JSON.stringify(resolve(clone(input)));
      for (let i = 1; i < 100; i++) {
        const again = JSON.stringify(resolve(clone(input)));
        expect(again === first, `${name}: run ${i} diverged`).toBe(true);
      }
      expect(first.length).toBeGreaterThan(1000);
    }
  });

  it("every state field is a safe integer after every tick, in every scenario", () => {
    for (const { name, input } of scenarios()) {
      const state = initialState(normalizeInput(clone(input)));
      const log: LogEvent[] = [];
      const bad: string[] = [];
      nonIntegers(stateNumbers(state), `${name}@init`, bad);
      for (; state.tick < state.tickCap; state.tick++) {
        runTick(state, log);
        nonIntegers(stateNumbers(state), `${name}@${state.tick}`, bad);
        if (bad.length) break;
      }
      nonIntegers(log, `${name}.log`, bad);
      expect(bad).toEqual([]);
    }
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
      expect([...keys].filter((k) => /account|coin|purchase|entitlement|paying|billing/i.test(k))).toEqual([]);
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
