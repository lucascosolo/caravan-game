/**
 * Chunk 08 QA D4: every response body the server suite recorded (apps/server/test/
 * contract.test.ts → ./*.json) passes the guard the client runs on that route. A route the
 * client has no guard for yet is skipped and listed; one with no entry at all fails.
 */
import { describe, expect, it } from "vitest";
import { CONTRACT_GUARDS, checkContract } from "./routes.ts";

const files = import.meta.glob<{ route: string; status: number; body: unknown }>("./*.json", { eager: true, import: "default" });
const recorded = Object.entries(files).map(([p, f]) => ({ name: p.replace(/^\.\//, "").replace(/\.json$/, ""), ...f }));

describe("client–server contract", () => {
  it("has recorded bodies for the client-consumed routes", () => {
    expect(recorded.length).toBeGreaterThanOrEqual(20);
    for (const name of ["me", "unlocks", "progression", "unlocks-spend", "manifest", "formation", "formation-put", "formation-commit", "search", "candidates", "choose", "economy", "merge-preview", "refugees", "recruit", "party", "party-feed", "store", "store-purchase", "store-purchase-replay", "store-purchases", "cosmetics", "cosmetics-owned", "cosmetics-equip", "cosmetics-unequip", "trip-status-packed", "trip-start", "trip-commit", "trip-status-resolving", "trip-status-decide", "trip-preview", "trip-push", "trip-bank", "trip-status-banked", "trip-status-overrun", "trip-start-refused", "replay", "replay-owner", "replay-no-log", "inbox", "inbox-unread", "inbox-read", "inbox-strikes", "inbox-preferences", "onboarding", "onboarding-advance", "onboarding-skip"]) {
      expect(recorded.map((r) => r.name), name).toContain(name);
    }
  });

  for (const r of recorded) {
    const guard = CONTRACT_GUARDS[r.name];
    if (guard === undefined) {
      it(`${r.name}: has an entry in CONTRACT_GUARDS`, () => {
        expect.fail(`${r.name}.json (${r.route}) is recorded but has no entry in src/test/contract/routes.ts`);
      });
    } else if (guard === null) {
      it.skip(`${r.name} (${r.route}): no client guard yet — skipped`, () => undefined);
    } else {
      it(`${r.name} (${r.route}) passes its guard`, () => {
        expect(checkContract(r.name, r.body)).toBeNull();
      });
    }
  }

  it("would have caught chunk 08's QA B1 drift: a menu without the server's authored fields is refused", () => {
    const menu = recorded.find((r) => r.name === "candidates")!.body as { menu: Record<string, unknown> };
    const { authoredOutsideBand: _gone, ...drifted } = menu.menu;
    expect(checkContract("candidates", { menu: { ...drifted, usedAuthoredFallback: false } })).toMatch(/authoredOutsideBand/);
  });

  it("lists the routes skipped for want of a guard", () => {
    const skipped = recorded.filter((r) => CONTRACT_GUARDS[r.name] === null).map((r) => `${r.name} (${r.route})`);
    // Printed so the chunk that adds the guard sees which entries to fill in.
    console.info(`contract: skipped (no client guard yet): ${skipped.join(", ") || "none"}`);
    // Chunk 20's web screens filled in the last two (store, cosmetics): nothing is skipped now.
    expect(skipped).toEqual([]);
  });
});
