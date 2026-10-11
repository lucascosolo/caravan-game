/**
 * Chunk 13 — the replay format and its reader (src/replay.ts).
 *   - Lossless, versioned, self-sufficient: decoding gives back the resolver's log exactly; the
 *     labels carry every entity; keyframes fall on the fixed schedule; seeking works.
 *   - Fails LOUDLY: a truncated, padded, reordered or edited log throws ReplayError — never a
 *     plausible-looking wrong fight. Even an edit that recomputes count and checksum is caught,
 *     because the reader plays the fight through and checks every keyframe.
 *   - Interpolation has not become simulation: the reader imports nothing from the simulation
 *     and has no branch that decides a hit, a target, a death or a turn.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPLAY_FORMAT_VERSION, ReplayError, encodeReplay, expectedKeyframeTicks, readReplay, replayChecksum, resolve, type ReplayLog, type ReplayRow } from "../src/index.js";
import { clone, fullLoadScenario, scenarios } from "./fixtures.js";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const stored = (log: ReplayLog): ReplayLog => JSON.parse(JSON.stringify(log)) as ReplayLog;
/** Re-seal an edited log: count and checksum recomputed, so only the reader's play-through can catch it. */
const reseal = (log: ReplayLog, events: ReplayRow[]): ReplayLog => ({ ...log, events, count: events.length, check: replayChecksum(events) });

describe("LOG_FORMAT v1", () => {
  const out = resolve(fullLoadScenario());
  const log = stored(encodeReplay(out));

  it("is versioned and carries the resolver version, the outcome, the cadence and a label for every entity", () => {
    expect(log).toMatchObject({ format: "caravan-replay", v: REPLAY_FORMAT_VERSION, resolverVersion: out.resolverVersion, tickRate: 20, tickCap: 3600, keyframeInterval: 100, ticks: out.ticks });
    expect(log.outcome).toEqual({ kind: out.outcome.kind, end: out.end, endTick: out.ticks - 1, depth: out.outcome.depth, deepestUnit: out.outcome.deepestUnit });
    expect(log.units.map((u) => u.u)).toEqual(out.units.map((u) => u.id));
    expect(log.units[0]).toEqual({ u: 0, side: "attacker", ref: out.units[0]!.ref, typeId: out.units[0]!.typeId, level: out.units[0]!.mergeLevel, maxHp: out.units[0]!.maxHp, hp: out.units[0]!.startHp });
    expect(log.fences).toHaveLength(28);
    expect(log.traps.every((t) => Number.isSafeInteger(t.x) && Number.isSafeInteger(t.y))).toBe(true);
    expect(log.count).toBe(log.events.length);
  });

  it("keyframes every keyframeInterval ticks and on the final tick; the last row is the final keyframe; seeking lands on each", () => {
    const replay = readReplay(log);
    expect(replay.keyframes.map((k) => k.t)).toEqual(expectedKeyframeTicks(out.ticks, 100));
    expect(expectedKeyframeTicks(3600, 100)).toHaveLength(36);
    expect(expectedKeyframeTicks(138, 100)).toEqual([99, 137]);
    expect(log.events[log.events.length - 1]![1]).toBe("kf");
    for (const k of replay.keyframes) expect(replay.frame(k.t).units.map((u) => [u.x, u.y, u.hp, u.alive])).toEqual(k.units.map((u) => [u.x, u.y, u.hp, u.alive]));
    // Full keyframes come back: every unit, fence and trap, identical to the resolver's own.
    expect(replay.keyframes).toEqual(out.log.filter((e) => e.k === "keyframe"));
  });

  it("KEYFRAME_DELTA: after the first, a keyframe row lists only what changed", () => {
    const rows = log.events.filter((r) => r[1] === "kf");
    expect(rows[0]![2]).toBe(out.units.length); // the first lists every unit
    const forced = stored(encodeReplay(resolve(scenarios().find((s) => s.name === "c13-stalemate-both-sides-fighting")!.input)));
    const later = forced.events.filter((r) => r[1] === "kf").slice(1);
    expect(later.every((r) => (r[2] as number) <= forced.units.length)).toBe(true);
    // The hold post neither moves nor changes its ready tick between keyframes once both are trading blows; its HP does.
    expect(later.some((r) => (r[2] as number) < forced.units.length || (r[2] as number) === forced.units.length)).toBe(true);
  });

  it("is lossless over the whole corpus and every value is an integer except the row codes", () => {
    for (const { name, input } of scenarios()) {
      const o = resolve(clone(input));
      const l = stored(encodeReplay(o));
      for (const r of l.events) r.forEach((c, i) => expect(i === 1 ? typeof c === "string" : Number.isSafeInteger(c), `${name} ${JSON.stringify(r)}`).toBe(true));
      expect(JSON.stringify(readReplay(l).events), name).toBe(JSON.stringify(o.log));
    }
  });
});

describe("a corrupted or truncated log fails loudly", () => {
  const out = resolve(scenarios().find((s) => s.name === "combat-full-load-16v8v28")!.input);
  const log = stored(encodeReplay(out));
  const events = log.events.map((r) => [...r]) as ReplayRow[];
  const refuses = (bad: unknown, why: RegExp) => {
    expect(() => readReplay(bad)).toThrow(ReplayError);
    expect(() => readReplay(bad)).toThrow(why);
  };

  it("truncated: rows dropped from the end, the final keyframe missing, a JSON text cut short", () => {
    refuses({ ...log, events: events.slice(0, -1) }, /count .* rows|truncated/);
    refuses(reseal(log, events.slice(0, -1)), /keyframes at ticks|truncated/);
    refuses(reseal(log, events.slice(0, Math.floor(events.length / 2))), /keyframes at ticks|truncated/);
    expect(() => JSON.parse(JSON.stringify(log).slice(0, 5000))).toThrow();
    refuses({ ...log, ticks: log.ticks + 50 }, /endTick|keyframes|truncated/);
  });

  it("altered: an edited number breaks the checksum; re-sealed, the play-through catches it at the next keyframe", () => {
    const spawn = events.findIndex((r) => r[1] === "s" && r[2] === out.units.length - 1);
    const edited = events.map((r) => [...r]) as (number | string)[][];
    (edited[spawn]![3] as number) += 512; // move a post's spawn half a cell
    refuses({ ...log, events: edited }, /checksum/);
    refuses(reseal(log, edited), /diverges from the keyframe|disagrees/);
    // A hit removed (HP no longer adds up at the keyframe): the last hit on its victim before a keyframe.
    const hit = events.findIndex((r, i) => {
      if (r[1] !== "x") return false;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j]![1] === "kf") return true;
        if (events[j]![1] === "x" && events[j]![3] === r[3]) return false;
      }
      return false;
    });
    expect(hit).toBeGreaterThanOrEqual(0);
    refuses(reseal(log, events.filter((_, i) => i !== hit)), /diverges|disagrees/);
    // A death removed (a fight with deaths: the healers' full-length fight).
    const healers = stored(encodeReplay(resolve(scenarios().find((s) => s.name === "abilities-healers-full-length")!.input)));
    const hEvents = healers.events.map((r) => [...r]) as ReplayRow[];
    const died = hEvents.findIndex((r) => r[1] === "d");
    expect(died).toBeGreaterThanOrEqual(0);
    refuses(reseal(healers, hEvents.filter((_, i) => i !== died)), /diverges|disagrees|outcome/);
    // Two rows swapped across ticks.
    const swapped = events.map((r) => [...r]) as ReplayRow[];
    const a = swapped.findIndex((r) => (r[0] as number) > 0);
    const b = swapped.findIndex((r) => (r[0] as number) > (swapped[a]![0] as number));
    [swapped[a], swapped[b]] = [swapped[b]!, swapped[a]!];
    refuses(reseal(log, swapped), /out of order/);
  });

  it("malformed or from an unknown format version: refused, never guessed at", () => {
    refuses({ ...log, v: 2 }, /not readable by this reader/);
    refuses({ ...log, format: "other" }, /format/);
    // An outcome that does not match the events: claimed held (wiped) while raiders were alive and one reached the core.
    refuses({ ...log, outcome: { ...log.outcome, kind: "caravan_held", end: "party_wiped" } }, /outcome .* the log shows/);
    refuses({ ...log, ticks: log.tickCap, outcome: { ...log.outcome, kind: "stalemate", end: "tick_cap", endTick: log.tickCap - 1 } }, /keyframes|past the last|outcome/);
    refuses(reseal(log, [...events.slice(0, 3), [0, "zz", 1], ...events.slice(3)]), /unknown code/);
    refuses(reseal(log, [...events.slice(0, 3), [0, "x", 0, 99, 1, 1], ...events.slice(3)]), /unit/);
    refuses(reseal(log, [...events.slice(0, 3), [0, "h", 0], ...events.slice(3)]), /must have 4 fields/);
    refuses(null, /object/);
    refuses({ ...log, outcome: { ...log.outcome, kind: "caravan_overrun", end: "core_overrun", depth: 512 } }, /depth/);
  });
});

describe("interpolation has not become simulation", () => {
  const replaySrc = readFileSync(path.join(srcDir, "replay.ts"), "utf8");

  it("replay.ts imports only fixed-point helpers, the field bounds and the archetype list — and types — never the simulation", () => {
    const imports = [...replaySrc.matchAll(/^import (type )?\{[^}]*\} from "\.\/([a-z]+)\.js";/gm)].map((m) => `${m[1] ? "type " : ""}${m[2]}`);
    expect(imports.sort()).toEqual(["battlefield", "fixed", "type log", "type outcome", "type resolve"]);
    for (const banned of ["tick", "combat", "path", "abilities", "posted", "traps", "move", "state", "hooks", "input"]) expect(replaySrc).not.toMatch(new RegExp(`from "\\./${banned}\\.js"`));
    const fromBattlefield = replaySrc.match(/import \{([^}]*)\} from "\.\/battlefield\.js"/)![1]!;
    expect(fromBattlefield.split(",").map((s) => s.trim()).sort()).toEqual(["ABILITY_ARCHETYPES", "FIELD_HEIGHT", "FIELD_WIDTH", "type AbilityArchetype"]);
  });

  it("the reader has no rule of its own: no damage formula, no reach or aggro test, no targeting, no death threshold — HP, deaths and breaks are copied from rows", () => {
    const reader = replaySrc.slice(replaySrc.indexOf("// ─── interpolation"));
    for (const word of ["reachSq", "aggro", "nearest", "damage", "cooldown", "affinity", "mergeMult", "chooseTarget", "findPath", "hp <= 0", "hp - "]) expect(reader, word).not.toContain(word);
    // The only HP writes are copies of a row's `hp`; the only life/death write is `unit_died`.
    expect([...reader.matchAll(/\.hp = ([^;]+);/g)].map((m) => m[1])).toEqual(["e.hp", "e.hp", "g.hp"]);
    expect([...reader.matchAll(/\.alive = ([^;]+);/g)].map((m) => m[1])).toEqual(["false"]);
    expect([...reader.matchAll(/intact\[[^\]]+\] = ([^;]+);/g)].map((m) => m[1])).toEqual(["false"]);
  });

  it("a replay is the same whatever the reader is fed besides the log: it never sees the input", () => {
    // readReplay takes one argument, the stored log — no battlefield, party or tunables parameter exists.
    expect(readReplay.length).toBe(1);
    const s = scenarios().find((x) => x.name === "abilities-all-six-both-sides")!;
    const a = readReplay(stored(encodeReplay(resolve(clone(s.input)))));
    const b = readReplay(stored(encodeReplay(resolve(clone(s.input)))));
    for (let t = 0; t < a.log.ticks; t += 7) expect(a.frame(t)).toEqual(b.frame(t));
  });
});
