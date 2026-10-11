/**
 * Chunk 23 QA S1/S2/S4: the trip guards against the server's REAL de-merge shape. Every body
 * here is a contract recording (apps/server/test/contract.test.ts writes them), so a server
 * rename fails this file instead of slipping past a hand-built fixture.
 */
import { describe, expect, it } from "vitest";
import bankJson from "../test/contract/trip-bank.json";
import bankedJson from "../test/contract/trip-status-banked.json";
import overrunJson from "../test/contract/trip-status-overrun.json";
import preview2Json from "../test/contract/trip-preview-2.json";
import { ShapeError, expectShape } from "./shape.ts";
import { bankResultShape, stakesPreviewShape, tripStatusShape } from "./tripShapes.ts";

const copy = <T,>(v: T): T => structuredClone(v);

describe("trip guards: the de-merge lists as the server sends them", () => {
  it("a preview after a death the caravan survived parses with both de-merge lists, item by item", () => {
    const raw = preview2Json.body;
    expect(raw.bankNow.unitsDeMerged.length).toBeGreaterThan(0);
    expect(raw.ifOverrun.unitsDeMergedNotDestroyed.length).toBeGreaterThan(0);
    const p = expectShape(stakesPreviewShape, raw);
    expect(p.bankNow.unitsDeMerged).toEqual(raw.bankNow.unitsDeMerged);
    expect(p.ifOverrun.unitsDeMergedNotDestroyed).toEqual(raw.ifOverrun.unitsDeMergedNotDestroyed);
    expect(p.bankNow.unitsDeMerged[0]).toEqual({ ref: expect.any(String), typeId: "desert.dust_rider", fromLevel: 3, toLevel: 2, diedAtEncounter: 2 });
    expect(p.ifOverrun.coinGoesTo).toBe("overrunning_party_owner_capped");
    expect(p.ifOverrun.unitDyingInTheFinalFight).toBe("de_merged_not_destroyed");
  });

  it("the bank answer and the banked ending carry restored.deMerged, never a silent empty list", () => {
    const bank = expectShape(bankResultShape, bankJson.body);
    expect(bank.restored.deMerged).toEqual(bankJson.body.restored.deMerged);
    expect(bank.restored.deMerged).toHaveLength(1);
    const banked = expectShape(tripStatusShape, bankedJson.body);
    const ending = banked.trip!.ending!;
    if (ending.kind !== "banked") throw new Error("fixture");
    expect(ending.restored.deMerged.map((u) => [u.fromLevel, u.toLevel, u.diedAtEncounter])).toEqual([[3, 2, 2]]);
  });

  it("the overrun ending lists its de-merged unit with the level it drops to", () => {
    const s = expectShape(tripStatusShape, overrunJson.body);
    const e = s.trip!.ending!;
    if (e.kind !== "overrun") throw new Error("fixture");
    expect(e.unitsDeMerged.map((u) => [u.mergeLevel, u.mergeLevelAfter])).toEqual([[2, 1]]);
    expect(e.unitsLostOutright.length).toBeGreaterThan(0);
  });

  it("the old client-side shape ({mergeLevel, mergeLevelAfter}) is not what the preview accepts", () => {
    const raw = copy(preview2Json.body) as unknown as { ifOverrun: { unitsDeMergedNotDestroyed: Record<string, unknown>[] } };
    raw.ifOverrun.unitsDeMergedNotDestroyed = [{ ref: "x", typeId: "desert.dust_rider", mergeLevel: 3, mergeLevelAfter: 2 }];
    expect(() => expectShape(stakesPreviewShape, raw)).toThrow(ShapeError);
  });

  it("a bank answer without restored.deMerged is bad_payload, not 'nobody died'", () => {
    const raw = copy(bankJson.body) as unknown as { restored: Record<string, unknown> };
    delete raw.restored["deMerged"];
    raw.restored["deMergePending"] = ["x"];
    expect(() => expectShape(bankResultShape, raw)).toThrow(/restored\.deMerged/);
  });

  it("a preview without bankNow.unitsDeMerged is bad_payload", () => {
    const raw = copy(preview2Json.body) as unknown as { bankNow: Record<string, unknown> };
    delete raw.bankNow["unitsDeMerged"];
    expect(() => expectShape(stakesPreviewShape, raw)).toThrow(/bankNow\.unitsDeMerged/);
  });
});
