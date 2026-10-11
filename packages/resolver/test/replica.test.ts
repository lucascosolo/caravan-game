/**
 * Chunk 12 QA S4 — the log.ts INTERPOLATION CONTRACT, executable. A replica interpolator that
 * reads NOTHING but the log (no input, no state, no tunables) reproduces every unit's position
 * on every tick of every fight in the determinism corpus, and every keyframe exactly. This is
 * what chunk 13's renderer must do; if the resolver ever moves a unit in a way the log does not
 * describe, this test fails. (The reviewer's p9_replica needed the posts' leash radii as a
 * `clamp` hint until RESOLVER_VERSION 6 logged the leash-clamped step as `disengage.amount`.)
 */
import { describe, expect, it } from "vitest";
import { FIELD_HEIGHT, FIELD_WIDTH, initialState, isqrt, legOffset, normalizeInput, resolve, runTick, type LogEvent } from "../src/index.js";
import { clone, scenarios } from "./fixtures.js";

interface Rep {
  x: number;
  y: number;
  wps: { x: number; y: number; b: number }[];
  ax: number;
  ay: number;
  len: number;
  prog: number;
  speed: number;
  pend: number | null;
  holding: boolean;
  alive: boolean;
}

/** Positions after every tick, from the log alone. */
function replicaPositions(log: readonly LogEvent[], ticks: number): number[][] {
  const units: Rep[] = [];
  const intact: boolean[] = [];
  const byTick: LogEvent[][] = Array.from({ length: ticks + 1 }, () => []);
  for (const e of log) byTick[e.t]!.push(e);
  for (const e of log) {
    if (e.k === "spawn") units[e.u] = { x: e.x, y: e.y, wps: [], ax: 0, ay: 0, len: -1, prog: 0, speed: 0, pend: null, holding: false, alive: true };
    if (e.k === "keyframe") e.fences.forEach((f) => (intact[f.f] ??= true));
    if (e.k === "path") for (const w of e.wp) if (w[2] >= 0) intact[w[2]] ??= true;
  }
  const maxX = FIELD_WIDTH - 1;
  const maxY = FIELD_HEIGHT - 1;
  const step = (u: Rep, budget: number): void => {
    let rem = budget;
    while (rem > 0 && u.wps.length > 0) {
      const w = u.wps[0]!;
      if (w.b >= 0 && intact[w.b] !== false) break;
      if (u.len < 0) {
        u.ax = u.x;
        u.ay = u.y;
        u.prog = 0;
        u.len = isqrt((w.x - u.x) * (w.x - u.x) + (w.y - u.y) * (w.y - u.y));
      }
      const left = u.len - u.prog;
      if (left <= rem) {
        u.x = w.x;
        u.y = w.y;
        rem -= left;
        u.wps.shift();
        u.len = -1;
        continue;
      }
      const p = u.prog + rem;
      u.x = Math.min(maxX, Math.max(0, u.ax + legOffset(w.x - u.ax, p, u.len)));
      u.y = Math.min(maxY, Math.max(0, u.ay + legOffset(w.y - u.ay, p, u.len)));
      u.prog = p;
      rem = 0;
    }
  };
  const out: number[][] = [];
  for (let t = 0; t < ticks; t++) {
    const evs = byTick[t]!;
    for (const u of units) {
      if (u.pend !== null) {
        u.speed = u.pend;
        u.pend = null;
      }
    }
    for (const e of evs) {
      if (e.k === "path") {
        const u = units[e.u]!;
        u.wps = e.wp.map((w) => ({ x: w[0], y: w[1], b: w[2] }));
        u.len = -1;
        u.speed = e.speed;
      }
      if (e.k === "hold") units[e.u]!.holding = e.holding;
    }
    // The unit's own movement phase (3 for attackers, 5 for posts): `speed` along its route,
    // or exactly the logged `amount` on a leash-clamped tick.
    units.forEach((u, id) => {
      if (!u.alive || u.holding) return;
      const clamped = evs.find((e): e is Extract<LogEvent, { k: "disengage"; amount: number }> => e.k === "disengage" && e.u === id && "amount" in e);
      step(u, clamped ? clamped.amount : u.speed);
    });
    // Phase 7: a dash is one more leg run.
    for (const e of evs) if (e.k === "ability" && e.a === "dash") step(units[e.u]!, e.tg[0]!.amount);
    for (const e of evs) {
      if (e.k === "speed") units[e.u]!.pend = e.speed;
      if (e.k === "fence_broken") intact[e.f] = false;
      if (e.k === "unit_died") units[e.u]!.alive = false;
    }
    out.push(units.flatMap((u) => [u.x, u.y]));
  }
  return out;
}

describe("QA-12 S4: a replica interpolator reproduces every position from the log alone", () => {
  it("every tick of every scenario in the determinism corpus: 0 position divergences, 0 keyframe mismatches, every dash ends at its logged (x, y)", () => {
    let scenariosRun = 0;
    let positions = 0;
    let clamps = 0;
    let dashes = 0;
    const divergences: string[] = [];
    for (const { name, input } of scenarios()) {
      const state = initialState(normalizeInput(clone(input)));
      const log: LogEvent[] = [];
      for (const u of state.units) log.push({ t: 0, k: "spawn", u: u.id, x: u.x, y: u.y });
      const actual: number[][] = [];
      for (; state.tick < state.tickCap; state.tick++) {
        runTick(state, log);
        actual.push(state.units.flatMap((u) => [u.x, u.y]));
      }
      // The manual loop is the resolver's own loop: same log.
      expect(JSON.stringify(log), name).toBe(JSON.stringify(resolve(clone(input)).log));
      const rep = replicaPositions(log, state.tickCap);
      for (let t = 0; t < actual.length; t++) {
        for (let i = 0; i < actual[t]!.length; i++) {
          positions++;
          if (actual[t]![i] !== rep[t]![i] && divergences.length < 5) divergences.push(`${name} t=${t} unit ${i >> 1} ${i & 1 ? "y" : "x"}: actual ${actual[t]![i]} replica ${rep[t]![i]}`);
        }
      }
      for (const e of log) {
        if (e.k === "keyframe") for (const k of e.units) expect([rep[e.t]![2 * k.u], rep[e.t]![2 * k.u + 1]], `${name} keyframe t=${e.t} unit ${k.u}`).toEqual([k.x, k.y]);
        if (e.k === "ability" && e.a === "dash") {
          dashes++;
          expect([rep[e.t]![2 * e.u], rep[e.t]![2 * e.u + 1]], `${name} dash t=${e.t}`).toEqual([e.x, e.y]);
        }
        if (e.k === "disengage" && "amount" in e) clamps++;
      }
      scenariosRun++;
    }
    expect(divergences).toEqual([]);
    expect(scenariosRun).toBe(scenarios().length);
    expect(positions).toBeGreaterThan(100_000);
    expect(dashes).toBeGreaterThan(5);
    expect(clamps).toBeGreaterThan(0); // the corpus exercises the leash clamp
  });
});
