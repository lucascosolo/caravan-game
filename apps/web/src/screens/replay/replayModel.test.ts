/**
 * Chunk 22: the replay model over real logs — the contract fixture (a fight the real resolver
 * fought on the server) and the resolver's whole golden corpus. The player only READS: every
 * frame it draws is the reader's frame, every feed line is a log row, and the end shows the
 * outcome the server recorded (a log whose ending disagrees is refused, never shown).
 */
import { readReplay } from "@caravan/resolver/replay";
import { describe, expect, it } from "vitest";
import type { ReplayView } from "../../api/replayTypes.ts";
import { goldenNames, goldenView, replayCaravan, replayNoLog, replayOwner } from "../../test/replayFixtures.ts";
import { clock, nextKeyframe, openReplay, prevKeyframe, type ReplayModel } from "./replayModel.ts";

function open(view: ReplayView): ReplayModel {
  const r = openReplay(view);
  if (!r.ok) throw new Error(`expected a playable replay, got: ${r.reason}`);
  return r.model;
}

describe("the replay model on the server's recorded fight (contract fixture)", () => {
  it("opens, names both sides from the caravan's point of view, and the end is the recorded outcome", () => {
    const view = replayCaravan();
    const m = open(view);
    expect(m.viewer).toBe("caravan");
    expect(m.ticks).toBe((view.log as { ticks: number }).ticks);
    // The log's ending is the recorded one (openReplay refuses otherwise).
    expect(m.replay.log.outcome.kind).toBe(view.outcome!.kind);
    expect(m.replay.log.outcome.depth).toBe(view.outcome!.depth);
    const text = m.feed.map((l) => l.text).join("\n");
    expect(text).toMatch(/^Your Well Digger/m);
    expect(text).toMatch(/the raiders' (Dust Rider|Well Digger)/);
    expect(text).toMatch(/ fell\.$/m);
    expect(text).toMatch(/Spike Pit sprang on/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    // Tally from the rows: three units fell in this fight.
    expect(m.tally.raidersFallen + m.tally.defendersFallen).toBe(m.feed.filter((l) => l.kind === "death").length);
    expect(m.tally.trapsSprung).toBe(1);
  });

  it("from the party owner's side the same fight reads the other way round", () => {
    const m = open(replayOwner());
    const text = m.feed.map((l) => l.text).join("\n");
    expect(text).toMatch(/^Your (Dust Rider|Well Digger)/m);
    expect(text).toMatch(/the caravan's Well Digger/);
    expect(text).toMatch(/the caravan's Spike Pit sprang on your/i);
    expect(m.entryEdges.length).toBeGreaterThan(0);
  });

  it("every drawn frame is the reader's frame: units at its positions with its HP; dead units are gone; seeking lands on keyframes", () => {
    const view = replayCaravan();
    const m = open(view);
    const reader = readReplay(view.log);
    for (const t of [0, 1, 37, Math.floor(m.ticks / 2), m.ticks - 1]) {
      const f = reader.frame(t);
      const s = m.scene(t);
      const alive = f.units.filter((u) => u.alive);
      expect(s.replayUnits!.map((u) => u.id)).toEqual(alive.map((u) => String(u.u)));
      for (const u of alive) {
        const drawn = s.replayUnits!.find((d) => d.id === String(u.u))!;
        expect(drawn.pos).toEqual({ x: u.x / 1024, y: u.y / 1024 });
        expect(drawn.hpFraction).toBe(u.hp / reader.log.units[u.u]!.maxHp);
      }
      expect(s.fences.length).toBe(f.fences.filter((x) => x.intact).length);
      expect(s.traps.filter((x) => x.spent).length).toBe(f.traps.filter((x) => x.spent).length);
      expect(s.showRadii).toBe(false);
      expect(s.drag).toBeNull();
    }
    expect(m.keyframeTicks).toEqual(reader.keyframes.map((k) => k.t));
    expect(nextKeyframe(m, 0)).toBe(m.keyframeTicks[0]);
    expect(prevKeyframe(m, m.keyframeTicks[1]! + 3)).toBe(m.keyframeTicks[1]);
    expect(prevKeyframe(m, 0)).toBe(0);
    expect(nextKeyframe(m, m.ticks - 1)).toBe(m.ticks - 1);
  });

  it("a fight resolved without a log is refused as 'no log', with the server's reason", () => {
    const r = openReplay(replayNoLog());
    expect(r).toEqual({ ok: false, noLog: true, reason: "no replay log was recorded for this fight" });
  });
});

describe("refusals: a log that cannot be trusted is never drawn", () => {
  it("a truncated log", () => {
    const view = goldenView("combat-full-load-16v8v28");
    const log = view.log as { events: unknown[]; count: number };
    const r = openReplay({ ...view, log: { ...log, events: log.events.slice(0, -1) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/replay refused/);
  });

  it("an edited number", () => {
    const view = goldenView("c11-guard-kills-raider-held");
    const log = view.log as { events: (number | string)[][] };
    const events = log.events.map((row) => (row[1] === "x" ? [...row.slice(0, 4), (row[4] as number) + 1, ...row.slice(5)] : row));
    expect(openReplay({ ...view, log: { ...log, events } }).ok).toBe(false);
  });

  it("a log whose ending disagrees with the recorded outcome", () => {
    const view = goldenView("c11-guard-kills-raider-held");
    const r = openReplay({ ...view, outcome: { ...view.outcome!, kind: "caravan_overrun", depth: 1024 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/recorded outcome is caravan_overrun/);
  });

  it("a body the server marked not renderable, even with a log present", () => {
    const view = goldenView("open-field-core");
    const r = openReplay({ ...view, renderable: false, reason: "log format v99 is not readable" });
    expect(r).toEqual({ ok: false, noLog: false, reason: "log format v99 is not readable" });
  });

  it("labels that do not match the log", () => {
    const view = goldenView("c11-mutual-kill-wipes-both-sides");
    expect(openReplay({ ...view, labels: { ...view.labels, units: view.labels.units.slice(1) } }).ok).toBe(false);
  });
});

describe("the whole golden corpus plays", () => {
  const names = goldenNames();

  it("has the corpus", () => {
    expect(names.length).toBeGreaterThanOrEqual(50);
  });

  it("every golden opens, scrubs to its end, and the end frame is the log's final keyframe", () => {
    for (const name of names) {
      const view = goldenView(name);
      const m = open(view);
      const end = m.scene(m.ticks - 1);
      const finalKf = m.replay.keyframes[m.replay.keyframes.length - 1]!;
      expect(end.replayUnits!.map((u) => u.id), name).toEqual(finalKf.units.filter((u) => u.alive).map((u) => String(u.u)));
      // Every death, trap, fence break, ability and core arrival in the log is a feed line.
      const rows = m.replay.events.filter((e) => ["unit_died", "trap_fired", "trap_nullified", "fence_broken", "ability", "core_reached", "hit"].includes(e.k)).length;
      expect(m.feed.length, name).toBe(rows);
    }
  });

  it("a full-load fight words traps, fence breaks and abilities with content display names", () => {
    const m = open(goldenView("combat-full-load-16v8v28"));
    const by = (k: string) => m.feed.filter((l) => l.kind === k).map((l) => l.text);
    expect(by("trap")[0]).toMatch(/^Your Spike Pit sprang on the raiders' Dust Rider \d+: \d+ damage/);
    expect(by("fence")[0]).toMatch(/^Your Brush Pile #\d+ broke\.$/);
    expect(by("ability")[0]).toMatch(/ used (Spur On|Pick Swing)/);
    expect(by("core")[0]).toMatch(/reached the core\.$/);
    expect(m.tally.coreReached).toBe(true);
    expect(m.deepestName).toMatch(/^the raiders' Dust Rider \d+$/);
  });

  it("the scene between two ticks is a lerp of the reader's frames (presentation only)", () => {
    const m = open(goldenView("c10-fast-mover-no-tunnelling"));
    const a = m.scene(1).replayUnits![0]!.pos;
    const b = m.scene(2).replayUnits![0]!.pos;
    const mid = m.scene(1.5).replayUnits![0]!.pos;
    expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 9);
    expect(mid.y).toBeCloseTo((a.y + b.y) / 2, 9);
  });

  it("marks: a trap that springs is marked at the trap for a moment, then fades", () => {
    const m = open(goldenView("c11-slow-trap"));
    const fired = m.replay.events.find((e) => e.k === "trap_fired")!;
    const at = m.scene(fired.t).marks!.filter((x) => x.kind === "trap");
    expect(at).toHaveLength(1);
    expect(at[0]!.age).toBe(0);
    expect(m.scene(fired.t + 200 > m.ticks - 1 ? m.ticks - 1 : fired.t + 200).marks!.filter((x) => x.kind === "trap")).toHaveLength(0);
  });

  it("clock reads fight time as m:ss", () => {
    expect(clock(0, 20)).toBe("0:00");
    expect(clock(1239, 20)).toBe("1:01");
  });
});
