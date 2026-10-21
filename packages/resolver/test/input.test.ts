/**
 * The input boundary: closed shapes at every level, integers only, stances and entry
 * bands enforced, anchors confirmed, PATH_CONNECTIVITY pinned, and no account-shaped key
 * can get in (GUARDRAILS §2).
 */
import { describe, expect, it } from "vitest";
import { INPUT_BOUNDS, RING_ANCHORS, assertResolveInput, resolve } from "../src/index.js";
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
    expect(() => assertResolveInput(mutated((o) => ((bf(o).fences as Mut[])[0]!.segment = 16)))).toThrow(/ring segment/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).fences as Mut[])[0]!.cell = { x: 13, y: 11 })))).toThrow(/segment 0's cell/);
    expect(() => assertResolveInput(mutated((o) => (bf(o).anchors = [])))).toThrow(/anchors/);
    expect(() => assertResolveInput(mutated((o) => (bf(o).anchors = [...RING_ANCHORS].reverse())))).toThrow(/anchors/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.cell = { x: 15, y: 10 })))).toThrow(/anchor/);
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

  it("QA-10 S4: a mover slower than one fixed unit per tick (moveSpeed < tickRate) is refused, for units and posts", () => {
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.moveSpeed = 19)))).toThrow(/moveSpeed 19 is below the tick rate 20/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.moveSpeed = 20)))).not.toThrow();
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.moveSpeed = 0)))).toThrow(/moveSpeed must be an integer ≥ 1/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.moveSpeed = 19)))).toThrow(/posts\[0\]\.moveSpeed 19 is below the tick rate/);
    // The bound follows the tick rate: at 40 ticks/s, 39 is too slow.
    expect(() => assertResolveInput(mutated((o) => { tn(o).tickRate = 40; (pt(o).units as Mut[])[0]!.moveSpeed = 39; }))).toThrow(/below the tick rate 40/);
  });

  it("QA-10 N3: a post's or trap's pos must lie inside its own cell", () => {
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.pos = { x: 15 * 1024 + 512, y: 9 * 1024 })))).toThrow(/posts\[0\]\.pos lies outside its cell/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.pos = { x: 15 * 1024 + 1023, y: 8 * 1024 })))).not.toThrow();
    const withTrap = clone(base()) as unknown as Mut;
    (bf(withTrap).traps as unknown[]).push({ ref: "t", cell: { x: 5, y: 5 }, pos: { x: 6 * 1024, y: 5 * 1024 + 512 }, typeId: "trap.spike_pit", category: "groundwork", affinity: "grit", damage: 250, effect: null });
    expect(() => assertResolveInput(withTrap)).toThrow(/traps\[0\]\.pos lies outside its cell/);
  });

  it("QA-10 S3: magnitudes are bounded so the breach price and every product stays a safe integer", () => {
    expect(INPUT_BOUNDS.maxHp).toBe(1_000_000);
    expect(() => assertResolveInput(mutated((o) => { (pt(o).units as Mut[])[0]!.hp = 1_000_001; (pt(o).units as Mut[])[0]!.maxHp = 1_000_001; }))).toThrow(/hp must be ≤ 1000000/);
    expect(() => assertResolveInput(mutated((o) => { (bf(o).fences as Mut[])[0]!.hp = 1_000_001; (bf(o).fences as Mut[])[0]!.maxHp = 1_000_001; }))).toThrow(/fences\[0\]\.maxHp must be ≤ 1000000/);
    expect(() => assertResolveInput(mutated((o) => { (bf(o).fences as Mut[])[0]!.hp = 1_000_000; (bf(o).fences as Mut[])[0]!.maxHp = 1_000_000; }))).not.toThrow();
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.attackCooldown = 60_001)))).toThrow(/attackCooldown must be ≤ 60000/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.attackCooldown = 60_000)))).not.toThrow();
    // QA-13 N4: the content minimum (400 ms) is the floor, so the log-size budget cannot be broken by input.
    expect(INPUT_BOUNDS.minAttackCooldownMs).toBe(400);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.attackCooldown = 399)))).toThrow(/attackCooldown must be ≥ 400|attackCooldown must be .*400/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.attackCooldown = 1)))).toThrow(/attackCooldown/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.attackCooldown = 400)))).not.toThrow();
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.attackCooldown = 399)))).toThrow(/attackCooldown/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.moveSpeed = 64 * 1024 + 1)))).toThrow(/moveSpeed must be ≤ 65536/);
    expect(() => assertResolveInput(mutated((o) => ((pt(o).units as Mut[])[0]!.offense = 1_000_001)))).toThrow(/offense must be ≤ 1000000/);
    expect(() => assertResolveInput(mutated((o) => (tn(o).tickRate = 1001)))).toThrow(/tickRate must be ≤ 1000/);
    expect(() => assertResolveInput(mutated((o) => (tn(o).battleLengthCapSeconds = 3601)))).toThrow(/battleLengthCapSeconds must be ≤ 3600/);
    expect(() => assertResolveInput(mutated((o) => ((bf(o).posts as Mut[])[0]!.defense = 1_000_001)))).toThrow(/defense must be ≤ 1000000/);
    // The worst case inside the bounds — hits × cooldownTicks × speedPerTick — is a safe integer.
    const worst = INPUT_BOUNDS.maxHp * ((INPUT_BOUNDS.maxMillis * INPUT_BOUNDS.maxTickRate) / 1000) * INPUT_BOUNDS.maxMoveSpeed;
    expect(worst).toBe(3_932_160_000_000_000);
    expect(Number.isSafeInteger(worst)).toBe(true);
  });

  it("resolve() validates before touching anything", () => {
    expect(() => resolve(null)).toThrow(/input must be an object/);
    expect(() => resolve({})).toThrow(/missing/);
  });
});
