import { describe, expect, it } from "vitest";
import { inboxShape } from "../api/inboxShapes.ts";
import { partyFeedShape } from "../api/shapes.ts";
import { expectShape } from "../api/shape.ts";
import inboxJson from "../test/contract/inbox.json";
import feedJson from "../test/contract/party-feed.json";
import { defenderLabel } from "./defender.ts";

describe("r2 N15: who a standing party struck", () => {
  it("reads a departed defender as a caravan that left the trail, never 'someone (someone)'", () => {
    expect(defenderLabel({ username: null, caravanName: null, departed: true })).toBe("a caravan that has since left the trail");
    // r3 N6: a username is never shown when the caravan name is known (the server now sends username: null).
    expect(defenderLabel({ username: "dev", caravanName: "Dusty Wheels", departed: false })).toBe("Dusty Wheels");
    expect(defenderLabel({ username: null, caravanName: "Dusty Wheels" })).toBe("Dusty Wheels");
    expect(defenderLabel({ username: null, caravanName: null })).toBe("someone");
  });

  it("the inbox and feed guards accept `departed` (and bodies from before it existed)", () => {
    const inbox = (inboxJson as { body: unknown }).body;
    const text = JSON.stringify(inbox);
    expect(text).toContain('"departed"');
    const marked = JSON.parse(text.replace(/"departed":false/g, '"departed":true').replace(/"username":"[^"]*"/g, '"username":null').replace(/"caravanName":"[^"]*"/g, '"caravanName":null'));
    expect(() => expectShape(inboxShape, inbox)).not.toThrow();
    expect(() => expectShape(inboxShape, marked)).not.toThrow();
    const feed = (feedJson as { body: { entries: { defender: Record<string, unknown> }[] } }).body;
    const parsed = expectShape(partyFeedShape, { ...feed, entries: feed.entries.map((e) => ({ ...e, defender: { ...e.defender, departed: true } })) });
    expect(parsed.entries.every((e) => e.defender.departed === true)).toBe(true);
  });
});
