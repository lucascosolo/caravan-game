/**
 * Chunk 14, the pure core: banding and escalation are integer-only; the draw is seeded,
 * reproducible, order-independent and honours the band passes, the authored share cap and
 * the widen-then-authored fallback; the sandbagging earn floor; and the no-Coin source scan
 * of the whole matchmaking path.
 */
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BAND_SPAN,
  CANDIDATES_PER_SEARCH,
  ESCALATION_PER_ENCOUNTER,
  REPUTATION_BAND_WIDTH,
  REPUTATION_BAND_WIDTH_MAX,
  authoredAllowance,
  bandCentre,
  bandOf,
  bandWidths,
  candidateSeed,
  escalatedCentre,
  escalationFor,
  sandbagEarnMultiplier,
  selectCandidates,
  type PoolEntry,
} from "../src/matchmaking/band.js";
import { authoredPartySpecs, AUTHORED_BANDS, AUTHORED_PARTIES_PER_BAND } from "../src/matchmaking/authored.js";

function entry(i: number, rating: number, authored = false): PoolEntry {
  return { partyId: `party-${String(i).padStart(3, "0")}`, ownerAccountId: `acct-${i}`, rating, authored };
}

describe("band math is integer-only and matches the tunables", () => {
  it("widths: ±150, then +100 per failed pass, capped at ±600", () => {
    expect(bandWidths()).toEqual([150, 250, 350, 450, 550, 600]);
    expect(REPUTATION_BAND_WIDTH).toBe(TUNABLES.REPUTATION_BAND_WIDTH);
    expect(REPUTATION_BAND_WIDTH_MAX).toBe(TUNABLES.REPUTATION_BAND_WIDTH_MAX);
    expect(BAND_SPAN).toBe(300);
  });

  it("escalation: +5% of the span per encounter beyond the first, whole integers", () => {
    expect(escalationFor(1)).toBe(0);
    expect(escalationFor(2)).toBe(15);
    expect(escalationFor(5)).toBe(60);
    expect(ESCALATION_PER_ENCOUNTER).toBe(15);
    for (let n = 1; n <= 50; n++) {
      expect(Number.isInteger(escalationFor(n))).toBe(true);
      expect(escalationFor(n + 1) - escalationFor(n)).toBe(15);
    }
    expect(escalatedCentre(1000, 3)).toBe(1030);
    expect(() => escalationFor(0)).toThrow(RangeError);
  });

  it("display bands start at the floor and are SPAN wide; REPUTATION_START sits in band 3", () => {
    expect(bandOf(100)).toEqual({ index: 0, low: 100, high: 399 });
    expect(bandOf(399).index).toBe(0);
    expect(bandOf(400).index).toBe(1);
    expect(bandOf(TUNABLES.REPUTATION_START)).toEqual({ index: 3, low: 1000, high: 1299 });
    expect(bandOf(0).index).toBe(0);
    expect(bandCentre(3)).toBe(1150);
    expect(() => bandOf(1.5)).toThrow(RangeError);
  });

  it("seed is fnv1a32 over caravan:trip:index:seq, case-insensitive on ids, distinct per search", () => {
    const a = candidateSeed("C1", "T1", 1, 1);
    expect(a).toBe(candidateSeed("c1", "t1", 1, 1));
    expect(Number.isInteger(a) && a >= 0 && a < 2 ** 32).toBe(true);
    expect(new Set([a, candidateSeed("c1", "t1", 1, 2), candidateSeed("c1", "t1", 2, 1), candidateSeed("c1", "t2", 1, 1), candidateSeed("c2", "t1", 1, 1)]).size).toBe(5);
  });

  it("authored allowance: ≤ 30% of the pool by ratio, but always enough to fill the menu", () => {
    expect(authoredAllowance(0)).toBe(3);
    expect(authoredAllowance(1)).toBe(2);
    expect(authoredAllowance(2)).toBe(1);
    expect(authoredAllowance(3)).toBe(1); // floor(3 × 0.3 / 0.7) = 1
    expect(authoredAllowance(10)).toBe(4); // 4 / 14 = 28.6% ≤ 30%
    expect(authoredAllowance(100)).toBe(42);
    for (let live = 3; live <= 200; live++) expect((authoredAllowance(live) * 10_000) / (live + authoredAllowance(live))).toBeLessThanOrEqual(TUNABLES.AUTHORED_PARTY_MAX_SHARE_BP);
  });

  it("sandbagging earn floor: full up to a 300 gap, then falling to the 0.25 floor; fixed-point integers", () => {
    expect(sandbagEarnMultiplier(-500)).toBe(FIXED_ONE);
    expect(sandbagEarnMultiplier(300)).toBe(FIXED_ONE);
    expect(sandbagEarnMultiplier(500)).toBe(FIXED_ONE - Math.floor((200 * FIXED_ONE) / TUNABLES.REPUTATION_GAP_DIVISOR));
    expect(sandbagEarnMultiplier(700)).toBe(TUNABLES.SANDBAG_EARN_MULT_MIN);
    expect(sandbagEarnMultiplier(5000)).toBe(TUNABLES.SANDBAG_EARN_MULT_MIN);
    for (let g = -1000; g <= 2000; g += 7) expect(Number.isInteger(sandbagEarnMultiplier(g))).toBe(true);
  });
});

describe("the seeded draw", () => {
  const pool = [...Array(12)].map((_, i) => entry(i, 900 + i * 20)); // 900..1120, all live

  it("returns exactly CANDIDATES_PER_SEARCH distinct picks from the first band when it holds enough", () => {
    const r = selectCandidates({ centre: 1000, seed: 12345, pool });
    expect(r.picks.length).toBe(CANDIDATES_PER_SEARCH);
    expect(new Set(r.picks.map((p) => p.partyId)).size).toBe(3);
    expect(r.bandWidthUsed).toBe(150);
    expect(r.passes.length).toBe(1);
    expect(r.usedAuthoredFallback).toBe(false);
    for (const p of r.picks) expect(Math.abs(p.rating - 1000)).toBeLessThanOrEqual(150);
  });

  it("is reproducible from (pool, seed, centre) and independent of the pool's input order", () => {
    const a = selectCandidates({ centre: 1000, seed: 777, pool });
    const b = selectCandidates({ centre: 1000, seed: 777, pool: [...pool].reverse() });
    const c = selectCandidates({ centre: 1000, seed: 777, pool: [...pool].sort(() => 0.5 - Math.random()) });
    expect(b.picks).toEqual(a.picks);
    expect(c.picks).toEqual(a.picks);
    const d = selectCandidates({ centre: 1000, seed: 778, pool });
    expect(d.picks).not.toEqual(a.picks); // a different seed is (almost surely) a different menu
  });

  it("different seeds spread the picks over the whole band (randomness shapes the menu, nothing else)", () => {
    const seen = new Set<string>();
    for (let s = 0; s < 200; s++) for (const p of selectCandidates({ centre: 1000, seed: s, pool }).picks) seen.add(p.partyId);
    const inBand = pool.filter((p) => Math.abs(p.rating - 1000) <= 150).map((p) => p.partyId);
    expect([...seen].sort()).toEqual(inBand.sort());
  });

  it("widens pass by pass when the band is thin and reports every pass", () => {
    const thin = [entry(1, 1000), entry(2, 1300), entry(3, 700), entry(4, 1560)];
    const r = selectCandidates({ centre: 1000, seed: 1, pool: thin });
    expect(r.passes.map((p) => [p.width, p.live])).toEqual([
      [150, 1],
      [250, 1],
      [350, 3],
    ]);
    expect(r.bandWidthUsed).toBe(350);
    expect(r.picks.map((p) => p.partyId).sort()).toEqual(["party-001", "party-002", "party-003"]);
    expect(r.usedAuthoredFallback).toBe(false);
  });

  it("skips parties the caller marks as not resolving, deterministically", () => {
    const first = selectCandidates({ centre: 1000, seed: 42, pool });
    const skip = first.picks[0]!.partyId;
    const again = selectCandidates({ centre: 1000, seed: 42, pool, skipped: new Set([skip]) });
    expect(again.picks.map((p) => p.partyId)).not.toContain(skip);
    expect(again.picks.length).toBe(3);
    expect(selectCandidates({ centre: 1000, seed: 42, pool, skipped: new Set([skip]) }).picks).toEqual(again.picks);
  });

  it("authored parties fill a short band, are capped by ratio in a full one, and never special-case the picks' shape", () => {
    const authored = [...Array(12)].map((_, i) => entry(100 + i, 1000, true));
    // Empty live pool: the menu is three authored parties.
    const empty = selectCandidates({ centre: 1000, seed: 9, pool: authored });
    expect(empty.picks.length).toBe(3);
    expect(empty.picks.every((p) => p.authored)).toBe(true);
    expect(empty.bandWidthUsed).toBe(150);
    expect(empty.usedAuthoredFallback).toBe(false);
    // Two live: one authored joins to make three.
    const two = selectCandidates({ centre: 1000, seed: 9, pool: [entry(1, 1000), entry(2, 1010), ...authored] });
    expect(two.picks.filter((p) => p.authored).length).toBe(1);
    expect(two.passes[0]).toEqual({ width: 150, live: 2, authoredInBand: 12, authoredAllowed: 1 });
    // Ten live: at most 4 authored (28.6%) enter the draw; over many seeds the authored share of menus stays near that.
    const live10 = [...Array(10)].map((_, i) => entry(i, 1000));
    let authoredPicks = 0;
    for (let s = 0; s < 500; s++) {
      const r = selectCandidates({ centre: 1000, seed: s, pool: [...live10, ...authored] });
      expect(r.passes[0]!.authoredAllowed).toBe(4);
      authoredPicks += r.picks.filter((p) => p.authored).length;
    }
    const share = authoredPicks / 1500;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.35);
  });

  it("EMPTY_POOL_BEHAVIOR: after the widest band, authored parties outside it fill the menu nearest-first; an unservable pool returns short", () => {
    const far = [entry(1, 1000), entry(50, 100, true), entry(51, 2000, true), entry(52, 2200, true)];
    const r = selectCandidates({ centre: 1000, seed: 3, pool: far });
    expect(r.bandWidthUsed).toBe(600);
    expect(r.usedAuthoredFallback).toBe(true);
    expect(r.picks.map((p) => p.partyId).sort()).toEqual(["party-001", "party-050", "party-051"]); // 100 and 2000 are nearer than 2200
    // Live parties outside the widest band never fill (the fallback is authored only).
    const short = selectCandidates({ centre: 1000, seed: 3, pool: [entry(1, 1000), entry(2, 5000), entry(3, 5000)] });
    expect(short.picks.length).toBe(1);
    expect(short.usedAuthoredFallback).toBe(false);
  });

  it("rejects floats, duplicates and bad seeds", () => {
    expect(() => selectCandidates({ centre: 1000.5, seed: 1, pool })).toThrow(RangeError);
    expect(() => selectCandidates({ centre: 1000, seed: -1, pool })).toThrow(RangeError);
    expect(() => selectCandidates({ centre: 1000, seed: 1, pool: [entry(1, 1000.25)] })).toThrow(RangeError);
    expect(() => selectCandidates({ centre: 1000, seed: 1, pool: [entry(1, 1000), entry(1, 1001)] })).toThrow(/duplicate/);
  });
});

describe("the authored set", () => {
  it("covers the lowest bands with three parties each, every stance, every region and 1/2/4 edge splits, on free types only", () => {
    const specs = authoredPartySpecs();
    expect(specs.length).toBe(AUTHORED_BANDS * AUTHORED_PARTIES_PER_BAND);
    expect(AUTHORED_BANDS).toBeGreaterThanOrEqual(3);
    expect(AUTHORED_PARTIES_PER_BAND).toBeGreaterThanOrEqual(3);
    for (let b = 0; b < AUTHORED_BANDS; b++) {
      const inBand = specs.filter((s) => s.band === b);
      expect(inBand.length).toBe(AUTHORED_PARTIES_PER_BAND);
      for (const s of inBand) expect(bandOf(s.rating).index).toBe(b);
      expect(inBand.map((s) => s.edgeCount).sort()).toEqual([1, 2, 4]);
    }
    expect(new Set(specs.map((s) => s.regionId)).size).toBe(4);
    expect(new Set(specs.map((s) => s.username)).size).toBe(specs.length);
    for (const s of specs) {
      expect(s.units.length).toBeGreaterThanOrEqual(3);
      expect(s.units.length).toBeLessThanOrEqual(TUNABLES.PARTY_SLOT_CAP);
      for (const u of s.units) expect(u.typeId.startsWith(`${s.regionId}.`)).toBe(true);
    }
  });
});

describe("structural: no Coin, purchase or entitlement path anywhere on the matchmaking path", () => {
  it("src/matchmaking and routes/matchmaking.ts never read or spend Coin, never price a reroll, never read online/busy state or region", () => {
    const srcDir = join(__dirname, "..", "src");
    const files = [...readdirSync(join(srcDir, "matchmaking")).map((f) => join(srcDir, "matchmaking", f)), join(srcDir, "routes", "matchmaking.ts")];
    const stripped = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const code = stripped(readFileSync(f, "utf8"));
      expect(/coin_balance|coin_spent|spendCoin|debitCoin|purchase|entitlement|billing|rerollCost|REFUGEE_REROLL/i.test(code), f).toBe(false);
      expect(/\bcost\b/i.test(code), `${f} mentions a cost`).toBe(false);
      expect(/online|offline|busy|last_seen|lastSeen|session/i.test(code), `${f} reads availability`).toBe(false);
      if (!f.endsWith("authored.ts")) expect(/region_id|regionId/i.test(code), `${f} reads region`).toBe(false);
      expect(/Math\.random|Date\.now/.test(code) && !f.endsWith(join("routes", "matchmaking.ts")), `${f} reads the clock or random`).toBe(false);
    }
  });
});
