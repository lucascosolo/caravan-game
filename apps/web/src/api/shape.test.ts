import { describe, expect, it } from "vitest";
import { array, boolean, expectShape, integer, literal, nullable, object, optional, ShapeError, string } from "./shape.ts";
import { meShape, progressionShape, spendResultShape, unlocksShape } from "./shapes.ts";
import { meResponse, progressionResponse, spendResult, unlocksResponse } from "../test/fixtures.ts";

const fails = (fn: () => unknown): ShapeError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ShapeError) return err;
    throw err;
  }
  throw new Error("expected a ShapeError");
};

describe("shape guards", () => {
  it("accept the server's real shapes unchanged", () => {
    expect(expectShape(unlocksShape, unlocksResponse())).toEqual(unlocksResponse());
    expect(expectShape(progressionShape, progressionResponse())).toEqual(progressionResponse());
    expect(expectShape(meShape, meResponse())).toEqual(meResponse());
    const sr = spendResult("trap", "trap.tripwire_snare", { trapPurchased: ["trap.tripwire_snare"] });
    expect(expectShape(spendResultShape, sr)).toEqual(sr);
  });

  it("name the first offending path", () => {
    const base = unlocksResponse();
    const bad = { webs: [base.webs[0], { ...base.webs[1]!, nodes: [{ ...base.webs[1]!.nodes[0]!, tier: -1 }] }] };
    const err = fails(() => expectShape(unlocksShape, bad));
    expect(err.path).toBe("webs[1].nodes[0].tier");
    expect(err.message).toBe("webs[1].nodes[0].tier: expected integer >= 0 <= 32, got number -1");
    expect(fails(() => expectShape(unlocksShape, { webs: {} })).message).toBe("webs: expected array, got object");
    expect(fails(() => expectShape(unlocksShape, null)).message).toBe("$: expected object, got null");
    expect(fails(() => expectShape(meShape, { account: { id: "a", username: "u" } })).path).toBe("caravans");
  });

  it("integer refuses fractions, strings, NaN, Infinity and out-of-range values", () => {
    const g = integer({ min: 0, max: 10 });
    expect(g(3, "x")).toBe(3);
    for (const v of [2.5, "3", NaN, Infinity, -Infinity, -1, 11, null, undefined, true]) expect(() => g(v, "x")).toThrow(ShapeError);
  });

  it("string, boolean, literal, nullable, optional, array", () => {
    expect(string()("a", "")).toBe("a");
    expect(() => string({ maxLength: 2 })("abc", "")).toThrow(ShapeError);
    expect(() => string()(1, "")).toThrow(ShapeError);
    expect(boolean()(false, "")).toBe(false);
    expect(() => boolean()("true", "")).toThrow(ShapeError);
    const lit = literal("a", "b");
    expect(lit("a", "")).toBe("a");
    expect(() => lit("c", "")).toThrow(ShapeError);
    expect(nullable(string())(null, "")).toBeNull();
    expect(() => nullable(string())(undefined, "")).toThrow(ShapeError);
    expect(optional(string())(undefined, "")).toBeUndefined();
    expect(() => optional(string())(null, "")).toThrow(ShapeError);
    expect(array(integer())([1, 2], "")).toEqual([1, 2]);
    expect(() => array(integer(), { maxLength: 1 })([1, 2], "")).toThrow(ShapeError);
    expect(fails(() => array(integer())([1, "2"], "xs")).path).toBe("xs[1]");
  });

  it("object ignores unknown fields and drops absent optional ones", () => {
    const g = object({ a: integer(), b: optional(string()) });
    expect(g({ a: 1, extra: true }, "")).toEqual({ a: 1 });
    expect(g({ a: 1, b: "x" }, "")).toEqual({ a: 1, b: "x" });
    expect(() => g([], "")).toThrow(ShapeError);
    expect(() => g("x", "")).toThrow(ShapeError);
  });
});
