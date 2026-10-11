/**
 * Chunk 12 QA S4 → chunk 13: the log.ts INTERPOLATION CONTRACT, executable, through the
 * resolver's OWN replay reader (src/replay.ts `readReplay`) — the code a client plays a
 * stored log with. For every fight in the determinism corpus: resolve it, encode the log
 * as the stored replay, round-trip it through JSON (as the server stores it), read it back,
 * and compare every unit's position, HP and life on EVERY tick with the simulation's own
 * state (a second, manual run of the same tick loop). The reader sees nothing but the log.
 * If the resolver ever moves, hurts or kills a unit in a way the log does not describe,
 * this fails.
 */
import { describe, expect, it } from "vitest";
import { encodeReplay, endOfTick, initialState, normalizeInput, readReplay, resolve, runTick, type LogEvent } from "../src/index.js";
import { clone, scenarios } from "./fixtures.js";

describe("the replay reader reproduces every tick of every corpus fight from the stored log alone", () => {
  it("0 position / HP / death divergences, every keyframe matched, every dash ends at its logged (x, y), the decoded log is the resolver's log", () => {
    let scenariosRun = 0;
    let positions = 0;
    let clamps = 0;
    let dashes = 0;
    const divergences: string[] = [];
    for (const { name, input } of scenarios()) {
      const out = resolve(clone(input));
      const replay = readReplay(JSON.parse(JSON.stringify(encodeReplay(out))));
      // Lossless: the stored form decodes to exactly the resolver's log.
      expect(JSON.stringify(replay.events), name).toBe(JSON.stringify(out.log));
      // The simulation's own per-tick state, from a manual run of the same loop.
      const state = initialState(normalizeInput(clone(input)));
      const log: LogEvent[] = [];
      for (const u of state.units) log.push({ t: 0, k: "spawn", u: u.id, x: u.x, y: u.y });
      for (let t = 0; t < out.ticks; t++, state.tick++) {
        runTick(state, log);
        endOfTick(state);
        const frame = replay.frame(t);
        for (const u of state.units) {
          positions++;
          const r = frame.units[u.id]!;
          if ((r.x !== u.x || r.y !== u.y || r.hp !== u.hp || r.alive !== u.alive) && divergences.length < 5) {
            divergences.push(`${name} t=${t} unit ${u.id}: sim (${u.x}, ${u.y}, ${u.hp}, ${String(u.alive)}) replay (${r.x}, ${r.y}, ${r.hp}, ${String(r.alive)})`);
          }
        }
        for (const f of state.fences) expect(frame.fences[f.index], `${name} t=${t} fence ${f.index}`).toEqual({ f: f.index, hp: f.hp, intact: f.intact });
        for (const tr of state.traps) expect(frame.traps[tr.index]!.spent, `${name} t=${t} trap ${tr.index}`).toBe(tr.spent);
      }
      for (const e of out.log) {
        if (e.k === "ability" && e.a === "dash") {
          dashes++;
          const f = replay.frame(e.t).units[e.u]!;
          expect([f.x, f.y], `${name} dash t=${e.t}`).toEqual([e.x, e.y]);
        }
        if (e.k === "disengage" && "amount" in e) clamps++;
      }
      // Seeking: every keyframe is a frame, exactly.
      for (const k of replay.keyframes) {
        const f = replay.frame(k.t);
        for (const ku of k.units) expect([f.units[ku.u]!.x, f.units[ku.u]!.y, f.units[ku.u]!.hp]).toEqual([ku.x, ku.y, ku.hp]);
      }
      scenariosRun++;
    }
    expect(divergences).toEqual([]);
    expect(scenariosRun).toBe(scenarios().length);
    expect(positions).toBeGreaterThan(50_000);
    expect(dashes).toBeGreaterThan(5);
    expect(clamps).toBeGreaterThan(0); // the corpus exercises the leash clamp
  });
});
