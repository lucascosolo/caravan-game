/**
 * Chunk 29: the inbox guards against the server's recorded bodies, and the drifts they must
 * refuse — above all a defender carrying an account id (PHASE-2 §29).
 */
import { describe, expect, it } from "vitest";
import inboxJson from "../test/contract/inbox.json";
import inboxPrefsJson from "../test/contract/inbox-preferences.json";
import inboxReadJson from "../test/contract/inbox-read.json";
import inboxUnreadJson from "../test/contract/inbox-unread.json";
import { ShapeError, expectShape } from "./shape.ts";
import { inboxShape, inboxUnreadShape } from "./inboxShapes.ts";

const body = (): { items: Record<string, unknown>[] } & Record<string, unknown> => JSON.parse(JSON.stringify(inboxJson.body)) as { items: Record<string, unknown>[] };
const refuse = (b: unknown): string => {
  try {
    expectShape(inboxShape, b);
  } catch (err) {
    if (err instanceof ShapeError) return err.message;
    throw err;
  }
  throw new Error("expected a refusal");
};

describe("inboxShape", () => {
  it("accepts the recorded bodies: an owner's strike batch, after a mark-all, and every timer category", () => {
    const owner = expectShape(inboxShape, inboxJson.body);
    expect(owner.items[0]?.category).toBe("party_strike");
    expect(owner.unreadCount).toBeGreaterThan(0);
    const read = expectShape(inboxShape, inboxReadJson.body);
    expect(read.unreadCount).toBe(0);
    expect(read.items.every((i) => !i.unread)).toBe(true);
    const prefs = expectShape(inboxShape, inboxPrefsJson.body);
    expect(prefs.items.map((i) => i.category)).toEqual(expect.arrayContaining(["refugees_arrived", "trip_cap_refilled", "mine_near_cap"]));
    expect(expectShape(inboxUnreadShape, inboxUnreadJson.body).unreadCount).toBe(owner.unreadCount);
  });

  it("refuses a defender that carries an account id", () => {
    const b = body();
    const strike = b.items[0] as { detail: { strikes: { defender: Record<string, unknown> }[] } };
    strike.detail.strikes[0]!.defender["accountId"] = "11111111-1111-4111-8111-111111111111";
    expect(refuse(b)).toMatch(/accountId/);
  });

  it("refuses an unknown category and a detail that does not match its category", () => {
    const b = body();
    b.items[0]!["category"] = "store_deal";
    expect(refuse(b)).toMatch(/category/);
    const c = body();
    c.items[0]!["category"] = "trip_cap_refilled";
    expect(refuse(c)).toMatch(/detail/);
  });

  it("refuses any delivery but in-app (no push exists yet) and ignores additive fields", () => {
    expect(refuse({ ...body(), delivery: "push" })).toMatch(/delivery/);
    expect(() => expectShape(inboxShape, { ...body(), somethingNew: 1 })).not.toThrow();
  });
});
