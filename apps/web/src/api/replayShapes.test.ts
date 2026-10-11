/**
 * Chunk 22: the replay route's guard against the server's recorded bodies, and the drifts it
 * must refuse. The log itself is opaque to the guard (readReplay is its validator).
 */
import { describe, expect, it } from "vitest";
import replayJson from "../test/contract/replay.json";
import replayNoLogJson from "../test/contract/replay-no-log.json";
import replayOwnerJson from "../test/contract/replay-owner.json";
import replayCompactedJson from "../test/contract/replay-compacted.json";
import { ShapeError, expectShape } from "./shape.ts";
import { replayShape } from "./replayShapes.ts";

const body = (): Record<string, unknown> => JSON.parse(JSON.stringify(replayJson.body)) as Record<string, unknown>;
const refuse = (b: unknown): string => {
  try {
    expectShape(replayShape, b);
  } catch (err) {
    if (err instanceof ShapeError) return err.message;
    throw err;
  }
  throw new Error("expected a refusal");
};

describe("replayShape", () => {
  it("accepts the recorded bodies: both participants of a real fight, and a fight with no log", () => {
    expect(expectShape(replayShape, replayJson.body).viewer).toBe("caravan");
    expect(expectShape(replayShape, replayOwnerJson.body).viewer).toBe("party_owner");
    const none = expectShape(replayShape, replayNoLogJson.body);
    expect(none).toMatchObject({ renderable: false, log: null, logFormat: null, resolverVersion: null });
    expect(none.labels.units).toEqual([]);
  });

  it("PHASE-2 §36: accepts a compacted fight — no log, the outcome and the kept tally — and refuses a drifted summary", () => {
    const c = expectShape(replayShape, replayCompactedJson.body);
    expect(c).toMatchObject({ renderable: false, log: null, compacted: { reason: "size_budget" } });
    expect(c.compacted?.tally?.raiders).toBeGreaterThan(0);
    expect(c.outcome?.kind).toBeDefined();
    // Absent on every other body (an additive field).
    expect(expectShape(replayShape, replayJson.body).compacted).toBeUndefined();
    const b = JSON.parse(JSON.stringify(replayCompactedJson.body)) as Record<string, unknown> & { compacted: Record<string, unknown> & { tally: Record<string, unknown> } };
    expect(refuse({ ...b, compacted: { ...b.compacted, reason: "deleted" } })).toMatch(/^compacted\.reason/);
    expect(refuse({ ...b, compacted: { ...b.compacted, tally: { ...b.compacted.tally, raidersFallen: -1 } } })).toMatch(/^compacted\.tally\.raidersFallen/);
  });

  it("passes the log through untouched for the reader", () => {
    const b = body();
    expect(expectShape(replayShape, b).log).toBe(b["log"]);
  });

  it("ignores additive fields", () => {
    expect(() => expectShape(replayShape, { ...body(), somethingNew: 1 })).not.toThrow();
  });

  it("refuses drift: an unknown viewer, a missing outcome kind, a log that is not an object, unbounded labels, a float depth", () => {
    expect(refuse({ ...body(), viewer: "spectator" })).toMatch(/^viewer/);
    const b = body();
    expect(refuse({ ...b, outcome: { ...(b["outcome"] as object), kind: "won" } })).toMatch(/^outcome\.kind/);
    expect(refuse({ ...b, outcome: { ...(b["outcome"] as object), depth: 0.5 } })).toMatch(/^outcome\.depth/);
    expect(refuse({ ...b, log: [1, 2, 3] })).toMatch(/^log: expected object or null/);
    expect(refuse({ ...b, log: "gz:…" })).toMatch(/^log/);
    const labels = b["labels"] as { units: unknown[] };
    expect(refuse({ ...b, labels: { ...labels, units: Array.from({ length: 300 }, () => labels.units[0]) } })).toMatch(/^labels\.units/);
    expect(refuse({ ...b, renderable: "yes" })).toMatch(/^renderable/);
  });
});
