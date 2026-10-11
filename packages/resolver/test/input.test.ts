/**
 * The input boundary: closed shapes at every level, integers only, stances and entry
 * bands enforced, anchors confirmed, PATH_CONNECTIVITY pinned, and no account-shaped key
 * can get in (GUARDRAILS §2).
 */
import { describe, expect, it } from "vitest";
import { RING_ANCHORS, assertResolveInput, resolve } from "../src/index.js";
import { DEFAULT_TUNABLES, battlefield, clone, fence, input, party, post, unit } from "./fixtures.js";

type Mut = Record<string, unknown>;
const base = () => input(battlefield({ fences: [fence({ segment: 0 })], posts: [post("p", { x: 15, y: 8 })] }), party([unit({ ref: "a" })]), DEFAULT_TUNABLES);
const mutated = (patch: (o: Mut) => void): unknown => {
  const o = clone(base()) as unknown as Mut;
  patch(o);
  return o;
};
const bf = (o: Mut) => o.battlefield as Mut;
const pt = (o: Mut) => o.party as Mut;
const tn = (o: Mut) => o.tunables as Mut;

describe("assertResolveInput", () => {
  it("accepts the fixture", () => {
    expect(() => assertResolveInput(base())).not.toThrow();
  });

  it("refuses extra keys at every level by name, including account-shaped ones", () => {
    expect(() => assertResolveInput(mutated((o) => (o.accountId = "x")))).toThrow(/unknown key 'accountId'/);
    expect(() => assertResolveInput(mutated((o) => (o.isPaying = true)))).toThrow(/unknown key 'isPaying'/);
    expect(() => assertResolveInput(mutated((o) => (bf(o).elevation = [])))).toThrow(/unknown key 'elevation'/);
    expect(() => assertResolveInput(mutated((o) => (pt(o).ownerAccountId = "x")))).toThrow(/unknown key 'ownerAccountId'/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.entitlement = "vip")))).toThrow(/unknown key 'entitlement'/);
    expect(() => assertResolveInput(mutated((o) => (tn(o).damageBonus = 2)))).toThrow(/unknown key 'damageBonus'/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.cover = 1)))).toThrow(/unknown key 'cover'/);
  });

  it("refuses any float anywhere", () => {
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.moveSpeed = 1536.5)))).toThrow(/integer/);
    expect(() => assertResolveInput(mutated((o) => (tn(o).tickRate = 20.5)))).toThrow(/integer/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).fences as Mut[])[0]!.hp = 299.9)))).toThrow(/integer/);
  });

  it("enforces stances, entry bands, the ring and the anchors", () => {
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.stance = "flank")))).toThrow(/stance/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.entry = { edge: "north", cell: { x: 15, y: 2 } })))).toThrow(/entry band/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.entry = { edge: "up", cell: { x: 15, y: 0 } })))).toThrow(/edge/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).fences as Mut[])[0]!.segment = 28)))).toThrow(/ring segment/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).fences as Mut[])[0]!.cell = { x: 13, y: 11 })))).toThrow(/segment 0's cell/);
    expect(() => assertResolveInput(mutated((o) => (bf(o).anchors = [])))).toThrow(/anchors/);
    expect(() => assertResolveInput(mutated((o) => (bf(o).anchors = [...RING_ANCHORS].reverse())))).toThrow(/anchors/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.cell = { x: 11, y: 11 })))).toThrow(/anchor/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.stance = "charge")))).toThrow(/stance/);
    expect(() => assertResolveInput(mutated((o) => (bf(o).grid = { width: 64, height: 64 })))).toThrow(/lattice/);
  });

  it("refuses duplicate refs, dead units, an empty party and a wrong connectivity", () => {
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[]).push(clone((pt(o).units as Mut[])[0]!)))))).toThrow(/duplicate party unit ref/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).fences as Mut[]).push(clone((bf(o).fences as Mut[])[0]!)))))).toThrow(/duplicate fence ref/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.hp = 0)))).toThrow(/hp/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.hp = 0)))).toThrow(/dead units/);
    expect(() => assertResolveInput(mutated((o) => (pt(o).units = [])))).toThrow(/empty/);
    expect(() => assertResolveInput(mutated((o) => (tn(o).pathConnectivity = 8)))).toThrow(/pathConnectivity must be 4/);
    expect(() => resolve(mutated((o) => (tn(o).pathConnectivity = 8)))).toThrow(/pathConnectivity/);
  });

  it("resolve() validates before touching anything", () => {
    expect(() => resolve(null)).toThrow(/input must be an object/);
    expect(() => resolve({})).toThrow(/missing/);
  });
});
