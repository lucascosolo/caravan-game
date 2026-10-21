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
import { depthPercent } from "./depth.ts";
import { END_HOLD_SECONDS, OPENING_HOLD_SECONDS, HIT_MARK_SECONDS, MARK_SECONDS, REPLAY_GEOMETRY, clock, nextKeyframe, openReplay, prevKeyframe, type ReplayModel } from "./replayModel.ts";

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
    // QA S7: a death names the row that took the unit to 0 HP.
    expect(text).toMatch(/^The raiders' Dust Rider fell to your Well Digger 1\.$/m); // chunk 37 balance pass: the contract fixture's fight re-recorded under the tuned content (defense ×1.5, traps ×1.5, speed ×0.7) — no posted unit falls now
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
      const rows = m.replay.events.filter((e) => ["unit_died", "trap_fired", "trap_nullified", "fence_broken", "ability", "core_reached", "hit", "fence_hit"].includes(e.k)).length;
      expect(m.feed.length, name).toBe(rows);
    }
  });

  it("a full-load fight words traps, fence breaks and abilities with content display names", () => {
    const m = open(goldenView("combat-full-load-16v8v28"));
    const by = (k: string) => m.feed.filter((l) => l.kind === k).map((l) => l.text);
    expect(by("trap")[0]).toMatch(/^Your Spike Pit sprang on the raiders' Dust Rider \d+: \d+ damage/);
    expect(by("fence")[0]).toMatch(/^Your Brush Pile #\d+ broke\.$/);
    // The regenerated 16v8v28 fight (146 ticks) holds no ability row at all; the other full-load golden (24 units, 177 ability rows) carries the ability wording.
    const full = open(goldenView("c13-full-load-full-length"));
    expect(full.feed.filter((l) => l.kind === "ability").map((l) => l.text)[0]).toMatch(/ used (Spur On|Pick Swing)/);
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

describe("chunk 22 QA fixes in the model", () => {
  it("S1: past the last tick the frame holds and the final rows' marks play out (the deciding kill is seen)", () => {
    const m = open(replayCaravan());
    const last = m.ticks - 1;
    const final = m.replay.events.filter((e) => e.k === "unit_died").at(-1)!;
    expect(final.t).toBe(last);
    const atEnd = m.scene(last);
    const held = m.scene(last + 0.5 * END_HOLD_SECONDS * m.tickRate);
    expect(held.replayUnits).toEqual(atEnd.replayUnits);
    const death = held.marks!.find((x) => x.kind === "death" && x.id === `m${m.replay.events.indexOf(final)}`);
    expect(death, "the last death's cross is still on the field during the hold").toBeDefined();
    expect(death!.age).toBeGreaterThan(0);
    expect(death!.age).toBeLessThan(1);
  });

  it("S4: a hit row yields a line mark from the attacker's to the target's frame position at that tick", () => {
    const view = replayCaravan();
    const m = open(view);
    const reader = readReplay(view.log);
    const i = m.replay.events.findIndex((e) => e.k === "hit");
    const hit = m.replay.events[i] as Extract<(typeof m.replay.events)[number], { k: "hit" }>;
    const mark = m.scene(hit.t).marks!.find((x) => x.id === `m${i}`)!;
    expect(mark.kind).toBe("hit");
    const f = reader.frame(hit.t);
    expect(mark.from).toEqual({ x: f.units[hit.u]!.x / 1024, y: f.units[hit.u]!.y / 1024 });
    expect(mark.pos).toEqual({ x: f.units[hit.v]!.x / 1024, y: f.units[hit.v]!.y / 1024 });
    // A fence hit is marked too, at the segment, and worded in the feed.
    const fm = open(goldenView("combat-full-load-16v8v28"));
    const fi = fm.replay.events.findIndex((e) => e.k === "fence_hit");
    expect(fm.scene(fm.replay.events[fi]!.t).marks!.find((x) => x.id === `m${fi}`)!.kind).toBe("fence_hit");
    expect(fm.feed.find((l) => l.key === fi)!.text).toMatch(/^The raiders' Dust Rider \d+ hit your Brush Pile #\d+ for \d+/);
  });

  it("S5: a mark's life is wall-clock — at 4× it spans four times as many fight ticks", () => {
    const m = open(goldenView("c11-slow-trap"));
    const fired = m.replay.events.find((e) => e.k === "trap_fired")!;
    const life1 = MARK_SECONDS * m.tickRate;
    const trapAt = (at: number, speed: number) => m.scene(at, { speed }).marks!.filter((x) => x.kind === "trap");
    expect(trapAt(Math.min(m.ticks - 1, fired.t + life1 * 1.5), 1)).toHaveLength(0);
    expect(trapAt(Math.min(m.ticks - 1, fired.t + life1 * 1.5), 4)).toHaveLength(1);
    expect(HIT_MARK_SECONDS).toBeLessThan(MARK_SECONDS);
  });

  it("S6: depth reads 'reached the core' only when the core was reached; otherwise floored and capped at 99", () => {
    expect(depthPercent(1021, false)).toBe(99);
    expect(depthPercent(1023, false)).toBe(99);
    expect(depthPercent(1024, true)).toBe(100);
    expect(depthPercent(529, false)).toBe(51);
    expect(depthPercent(0, false)).toBe(0);
  });

  it("S7: how each fighter fared, from the rows, for both viewers", () => {
    const c = open(replayCaravan()).fates.map((f) => f.text);
    expect(c).toEqual([
      "Your Well Digger 1: still standing at the end.",
      "Your Well Digger 2: still standing at the end.",
      "The raiders' Dust Rider: fell to your Well Digger 1 at 0:19.",
      "The raiders' Well Digger: fell to your Well Digger 1 at 0:37.",
    ]);
    const o = open(replayOwner()).fates.map((f) => f.text);
    expect(o.slice(0, 2)).toEqual(["Your Dust Rider: fell to the caravan's Well Digger 1 at 0:19.", "Your Well Digger: fell to the caravan's Well Digger 1 at 0:37."]);
    const full = open(goldenView("combat-full-load-16v8v28")).fates.map((f) => f.text);
    expect(full).toContain("The raiders' Dust Rider 16: reached the core at 0:07.");
    expect(full).toContain("Your Well Digger 1: still standing when the core was overrun.");
  });

  it("D1: stances and siege come from the server's labels (the job's snapshots) and reach the scene", () => {
    const view = replayCaravan();
    const m = open(view);
    const s = m.scene(0);
    for (const u of s.replayUnits!) expect(u.stance).toBe(view.labels.units[Number(u.id)]!.stance);
    expect(s.replayUnits!.map((u) => u.stance)).toEqual(["nearest", "traps", "hold", "guard"]);
    expect(s.siege).toEqual([{ id: "0:siege.battering_wagon", typeId: "siege.battering_wagon", edge: "north", along: 0.3 }]);
    expect(m.siegeNames).toEqual(["Battering Wagon (hits timber fences harder)"]);
    expect(m.hasStances).toBe(true);
    // A golden body names no siege, so the feed never credits one the player cannot see.
    const full = open(goldenView("combat-full-load-16v8v28"));
    expect(full.feed.filter((l) => /harmless/.test(l.text)).every((l) => !/siege/.test(l.text))).toBe(true);
    // With a trap-countering piece labelled, the nullified trap names it.
    const g = goldenView("combat-full-load-16v8v28");
    const withSiege = open({ ...g, labels: { ...g.labels, siege: [{ typeId: "siege.rock_rake", displayName: "Rock Rake", counters: { kind: "trap", category: "groundwork" } }] } });
    expect(withSiege.feed.find((l) => /harmless/.test(l.text))!.text).toMatch(/; the party's Rock Rake made it harmless\.$/);
    const owner = open({ ...g, viewer: "party_owner", labels: { ...g.labels, siege: [{ typeId: "siege.rock_rake", displayName: "Rock Rake", counters: { kind: "trap", category: "groundwork" } }] } });
    expect(owner.feed.find((l) => /harmless/.test(l.text))!.text).toMatch(/your party's Rock Rake made it harmless\.$/);
  });

  it("N3: a siege-nullified trap is not counted as sprung", () => {
    const t = open(goldenView("combat-full-load-16v8v28")).tally;
    expect(t.trapsSprung).toBe(3);
    expect(t.trapsNullified).toBe(3);
  });

  it("N7: a body for another fight, or labels naming another type, are refused", () => {
    const view = replayCaravan();
    expect(openReplay(view, { jobId: "encounter:00000000-0000-4000-8000-0000000000ff:1" }).ok).toBe(false);
    expect(openReplay(view, { jobId: view.jobId, encounterIndex: 2 }).ok).toBe(false);
    expect(openReplay(view, { jobId: view.jobId, encounterIndex: view.encounterIndex }).ok).toBe(true);
    const wrongType = { ...view, labels: { ...view.labels, units: view.labels.units.map((u, i) => (i === 0 ? { ...u, typeId: "desert.well_digger", displayName: "Well Digger" } : u)) } };
    const r = openReplay(wrongType);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("the server's labels do not match the stored log");
  });

  it("r2 N14: the opening frame takes in every raider's start cell, so nobody is off-canvas at 0:00; the camera then moves in to the close frame", () => {
    const m = open(replayCaravan());
    const r = m.frameRect;
    for (const e of m.replay.events) {
      if (e.k !== "spawn" || m.replay.log.units[e.u]?.side !== "attacker") continue;
      const x = Math.floor(e.x / 1024);
      const y = Math.floor(e.y / 1024);
      expect(x).toBeGreaterThanOrEqual(r.x);
      expect(x).toBeLessThan(r.x + r.w);
      expect(y).toBeGreaterThanOrEqual(r.y);
      expect(y).toBeLessThan(r.y + r.h);
    }
    expect(m.closeTick).toBeGreaterThanOrEqual(0);
    expect(m.closeTick).toBeLessThan(m.ticks);
    // r3 N12: the wide opening is held at most OPENING_HOLD_SECONDS before the camera moves in.
    expect(m.closeTick).toBeLessThanOrEqual(Math.round(OPENING_HOLD_SECONDS * m.replay.log.tickRate));
  });

  it("S2: the close frame covers the ring and reaches toward every edge raiders came in from — not the whole field", () => {
    const m = open(replayCaravan());
    const r = m.closeRect;
    for (const c of REPLAY_GEOMETRY.ringCells) {
      expect(c.x).toBeGreaterThanOrEqual(r.x);
      expect(c.x).toBeLessThan(r.x + r.w);
      expect(c.y).toBeGreaterThanOrEqual(r.y);
      expect(c.y).toBeLessThan(r.y + r.h);
    }
    expect(r.w).toBeLessThan(REPLAY_GEOMETRY.width);
    expect(r.h).toBeLessThan(REPLAY_GEOMETRY.height);
    expect(r.minCellPx).toBeGreaterThanOrEqual(32);
    expect(m.entryEdges).toEqual(["north", "east"]);
    expect(m.keyframeSeconds).toBe(5);
  });
});
