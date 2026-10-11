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
import { authoredOverShare, type AuthoredServedShare } from "../src/matchmaking/band.js";
import { AUTHORED_BANDS, AUTHORED_PARTIES_PER_BAND, authoredBands, authoredPartySpecs, maxLivingTier, rungsForPoints } from "../src/matchmaking/authored.js";
import { LIVING_UNLOCK_WEBS, REGION_IDS, SIEGE_TYPES, pointsPerPoolAtLadderCap } from "@caravan/content";

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
    // Chunk 14 QA S4: without the fill (every pass but the widest) the allowance is the ratio alone.
    expect(authoredAllowance(0, 3, { fill: false })).toBe(0);
    expect(authoredAllowance(2, 3, { fill: false })).toBe(0);
    expect(authoredAllowance(3, 3, { fill: false })).toBe(1);
    expect(authoredAllowance(10, 3, { fill: false })).toBe(4);
    // Chunk 25: over the served share the ratio allowance is weighted down (x0.25, floored), the fill never is.
    expect(authoredAllowance(10, 3, { overShare: true })).toBe(1);
    expect(authoredAllowance(10, 3, { overShare: true, fill: false })).toBe(1);
    expect(authoredAllowance(3, 3, { overShare: true, fill: false })).toBe(0);
    expect(authoredAllowance(0, 3, { overShare: true })).toBe(3);
    expect(authoredAllowance(100, 3, { overShare: true })).toBe(Math.floor((42 * TUNABLES.AUTHORED_OVER_SHARE_WEIGHT_BP) / 10_000));
  });

  it("served share: over the cap only when authored x 10000 > served x share, never on an empty window; integers only", () => {
    const share = (served: number, authored: number): AuthoredServedShare => ({ band: 3, window: 40, served, authored });
    expect(authoredOverShare(null)).toBe(false);
    expect(authoredOverShare(undefined)).toBe(false);
    expect(authoredOverShare(share(0, 0))).toBe(false);
    expect(authoredOverShare(share(10, 3))).toBe(false); // exactly 30%: not over
    expect(authoredOverShare(share(10, 4))).toBe(true);
    expect(authoredOverShare(share(1, 1))).toBe(true);
    expect(authoredOverShare(share(7, 2))).toBe(false); // 28.6%
    expect(authoredOverShare(share(40, 12))).toBe(false);
    expect(authoredOverShare(share(40, 13))).toBe(true);
    expect(() => authoredOverShare(share(3, 4))).toThrow(RangeError);
    expect(() => authoredOverShare(share(3.5, 1))).toThrow(RangeError);
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

  it("authored parties fill a short band only at the widest pass, are capped by ratio in a full one, and never special-case the picks' shape", () => {
    const authored = [...Array(12)].map((_, i) => entry(100 + i, 1000, true));
    // Empty live pool: every pass widens (authored by ratio only: none), the widest fills the menu with three authored parties.
    const empty = selectCandidates({ centre: 1000, seed: 9, pool: authored });
    expect(empty.picks.length).toBe(3);
    expect(empty.picks.every((p) => p.authored)).toBe(true);
    expect(empty.bandWidthUsed).toBe(REPUTATION_BAND_WIDTH_MAX);
    expect(empty.passes.map((p) => p.authoredAllowed)).toEqual([0, 0, 0, 0, 0, 3]);
    expect(empty.usedAuthoredFallback).toBe(false);
    expect(empty.authoredWeightedDown).toBe(false);
    // Two live: no authored joins until the widest pass, where one makes three.
    const two = selectCandidates({ centre: 1000, seed: 9, pool: [entry(1, 1000), entry(2, 1010), ...authored] });
    expect(two.picks.filter((p) => p.authored).length).toBe(1);
    expect(two.passes[0]).toEqual({ width: 150, live: 2, authoredInBand: 12, authoredAllowed: 0 });
    expect(two.bandWidthUsed).toBe(REPUTATION_BAND_WIDTH_MAX);
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

  it("chunk 14 QA S4: authored in band, live one step wider - the live parties win and no authored party is drawn", () => {
    const pool = [entry(100, 1000, true), entry(101, 1005, true), entry(102, 995, true), entry(1, 1200), entry(2, 1210), entry(3, 800)];
    for (let seed = 0; seed < 50; seed++) {
      const r = selectCandidates({ centre: 1000, seed, pool });
      // The first pass (three authored in band, no live) does NOT fill; the search widens and the
      // live parties one step out form the menu, with at most the ratio's one authored party.
      expect(r.bandWidthUsed).toBe(250);
      expect(r.passes).toEqual([
        { width: 150, live: 0, authoredInBand: 3, authoredAllowed: 0 },
        { width: 250, live: 3, authoredInBand: 3, authoredAllowed: 1 },
      ]);
      expect(r.picks.filter((p) => !p.authored).length).toBeGreaterThanOrEqual(2);
      expect(r.picks.filter((p) => p.authored).length).toBeLessThanOrEqual(1);
    }
    // Four live one step wider: the ratio still admits one authored party, the menu is drawn at 250 from 4 + 1.
    const four = selectCandidates({ centre: 1000, seed: 3, pool: [...pool, entry(4, 1220)] });
    expect(four.bandWidthUsed).toBe(250);
    expect(four.passes[1]).toEqual({ width: 250, live: 4, authoredInBand: 3, authoredAllowed: 1 });
    // Two live one step wider and one authored in band: still widen to the widest before an authored party fills.
    const r = selectCandidates({ centre: 1000, seed: 1, pool: [entry(100, 1000, true), entry(1, 1200), entry(2, 1210)] });
    expect(r.bandWidthUsed).toBe(REPUTATION_BAND_WIDTH_MAX);
    expect(r.picks.length).toBe(3);
  });

  it("chunk 25 served share: over the cap the authored allowance is weighted down, deterministically from the stored share, and releases under it", () => {
    const authored = [...Array(12)].map((_, i) => entry(100 + i, 1000, true));
    const live10 = [...Array(10)].map((_, i) => entry(i, 1000));
    const pool = [...live10, ...authored];
    const over: AuthoredServedShare = { band: 3, window: 40, served: 10, authored: 4 };
    const under: AuthoredServedShare = { band: 3, window: 40, served: 10, authored: 3 };
    const weighted = selectCandidates({ centre: 1000, seed: 5, pool, authoredServed: over });
    expect(weighted.authoredWeightedDown).toBe(true);
    expect(weighted.passes[0]!.authoredAllowed).toBe(1);
    const released = selectCandidates({ centre: 1000, seed: 5, pool, authoredServed: under });
    expect(released.authoredWeightedDown).toBe(false);
    expect(released.passes[0]!.authoredAllowed).toBe(4);
    expect(selectCandidates({ centre: 1000, seed: 5, pool, authoredServed: null }).passes[0]!.authoredAllowed).toBe(4);
    // Same inputs, same menu - the share is a replay input like the seed.
    expect(selectCandidates({ centre: 1000, seed: 5, pool, authoredServed: { ...over } }).picks).toEqual(weighted.picks);
    // Over many seeds the weighted draw serves fewer authored parties than the unweighted one.
    let w = 0;
    let u = 0;
    for (let seed = 0; seed < 300; seed++) {
      w += selectCandidates({ centre: 1000, seed, pool, authoredServed: over }).picks.filter((p) => p.authored).length;
      u += selectCandidates({ centre: 1000, seed, pool, authoredServed: under }).picks.filter((p) => p.authored).length;
    }
    expect(w).toBeLessThan(u / 2);
    // An empty live pool is still served: the weight never cuts below what fills the menu at the widest pass.
    const empty = selectCandidates({ centre: 1000, seed: 5, pool: authored, authoredServed: { band: 3, window: 40, served: 5, authored: 5 } });
    expect(empty.picks.length).toBe(3);
    expect(empty.authoredWeightedDown).toBe(true);
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

describe("the authored set (chunk 25)", () => {
  it("covers every band from the floor to the ceiling with twelve parties each: every region, stance pattern and edge split per band; every siege piece and living type overall", () => {
    const specs = authoredPartySpecs();
    const bands = authoredBands();
    expect(bands[0]).toBe(bandOf(TUNABLES.REPUTATION_FLOOR).index);
    expect(bands[bands.length - 1]).toBe(bandOf(TUNABLES.AUTHORED_REPUTATION_CEILING).index);
    expect(bands).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(AUTHORED_BANDS).toBe(bands.length);
    expect(AUTHORED_PARTIES_PER_BAND).toBeGreaterThanOrEqual(12);
    expect(specs.length).toBe(AUTHORED_BANDS * AUTHORED_PARTIES_PER_BAND);
    for (const b of bands) {
      const inBand = specs.filter((s) => s.band === b);
      expect(inBand.length).toBe(AUTHORED_PARTIES_PER_BAND);
      for (const s of inBand) {
        expect(bandOf(s.rating).index).toBe(b);
        expect(s.rating).toBeGreaterThanOrEqual(TUNABLES.REPUTATION_FLOOR);
      }
      for (const r of REGION_IDS) expect(inBand.filter((s) => s.regionId === r).map((s) => s.edgeCount).sort()).toEqual([1, 2, 4]);
      expect(new Set(inBand.map((s) => s.stancePattern))).toEqual(new Set(["nearest", "traps", "core", "mixed"]));
      expect(new Set(inBand.map((s) => s.rating)).size).toBe(inBand.length);
    }
    expect(new Set(specs.map((s) => s.username)).size).toBe(specs.length);
    for (const s of specs) {
      expect(s.username.startsWith("sys_outfit_")).toBe(true);
      expect(s.username.length).toBeLessThanOrEqual(32);
      expect(s.outfit.name.length).toBeGreaterThan(0);
      expect(s.outfit.flavor.length).toBeGreaterThan(0);
      expect(s.units.length).toBeGreaterThanOrEqual(3);
      expect(s.units.length).toBeLessThanOrEqual(TUNABLES.PARTY_SLOT_CAP);
      expect(s.siege.length).toBeLessThanOrEqual(TUNABLES.SIEGE_SLOT_CAP);
      for (const u of s.units) expect(u.typeId.startsWith(`${s.regionId}.`)).toBe(true);
      // No bypass: every party is reachable within one capped ladder per pool.
      expect(s.livingPoints).toBeLessThanOrEqual(pointsPerPoolAtLadderCap());
      expect(s.siegePoints).toBeLessThanOrEqual(pointsPerPoolAtLadderCap());
      expect(rungsForPoints(s.livingPoints)).toBeLessThanOrEqual(TUNABLES.LADDER_RUNGS_PER_POOL);
    }
    const siege = new Set(specs.flatMap((s) => s.siege));
    for (const t of SIEGE_TYPES) expect(siege.has(t.id), t.id).toBe(true);
    const types = new Set(specs.flatMap((s) => s.units.map((u) => u.typeId)));
    for (const r of REGION_IDS) for (const n of LIVING_UNLOCK_WEBS[r].nodes) expect(types.has(n.id), n.id).toBe(true);
    expect(new Set(specs.map((s) => s.outfit.name)).size).toBe(specs.length);
  });

  it("rises with the band: merge levels, party size, unit tier and siege count all grow; the floor band is unmerged starting types, the top band fields the merge cap", () => {
    const specs = authoredPartySpecs();
    const bands = authoredBands();
    const stat = (b: number, f: (s: (typeof specs)[number]) => number) => Math.max(...specs.filter((s) => s.band === b).map(f));
    const topLevel = bands.map((b) => stat(b, (s) => Math.max(...s.units.map((u) => u.mergeLevel))));
    const size = bands.map((b) => stat(b, (s) => s.units.length));
    const siege = bands.map((b) => stat(b, (s) => s.siege.length));
    for (let i = 1; i < bands.length; i++) {
      expect(topLevel[i]).toBeGreaterThanOrEqual(topLevel[i - 1]!);
      expect(size[i]).toBeGreaterThanOrEqual(size[i - 1]!);
      expect(siege[i]).toBeGreaterThanOrEqual(siege[i - 1]!);
    }
    expect(topLevel[0]).toBeLessThanOrEqual(2);
    expect(topLevel[bands.length - 1]).toBe(TUNABLES.MERGE_LEVEL_MAX);
    expect(siege[bands.length - 1]).toBe(TUNABLES.SIEGE_SLOT_CAP);
    for (const s of specs.filter((s) => s.band === bands[0])) {
      expect(s.livingPoints).toBe(0);
      expect(s.siegePoints).toBe(0);
    }
    expect(maxLivingTier(0)).toBe(0);
    expect(maxLivingTier(bands.length - 1)).toBe(TUNABLES.UNLOCK_WEB_TIERS);
    expect(rungsForPoints(0)).toBe(0);
    expect(rungsForPoints(1)).toBe(1);
    expect(rungsForPoints(10)).toBe(10);
    expect(rungsForPoints(11)).toBe(11);
    expect(rungsForPoints(30)).toBe(20);
    expect(() => rungsForPoints(31)).toThrow(RangeError);
  });

  it("the outfit table keeps to the Old West archetypes: no Indigenous content", () => {
    const text = authoredPartySpecs().map((s) => `${s.outfit.name} ${s.outfit.flavor}`).join("\n");
    expect(/indian|native|tribe|tribal|apache|comanche|sioux|cheyenne|navajo|lakota|warrior|brave\b|chief|totem|tomahawk/i.test(text)).toBe(false);
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
      // authored.ts reaches unlock-web nodes for the system accounts (`purchasedNodeIds` - unlock points, never Coin).
      expect(/coin_balance|coin_spent|spendCoin|debitCoin|entitlement|billing|rerollCost|REFUGEE_REROLL/i.test(code), f).toBe(false);
      if (!f.endsWith("authored.ts")) expect(/purchase/i.test(code), f).toBe(false);
      expect(/\bcost\b/i.test(code), `${f} mentions a cost`).toBe(false);
      expect(/online|offline|busy|last_seen|lastSeen|session/i.test(code), `${f} reads availability`).toBe(false);
      if (!/authored(Outfits)?\.ts$/.test(f)) expect(/region_id|regionId/i.test(code), `${f} reads region`).toBe(false);
      expect(/Math\.random|Date\.now/.test(code) && !f.endsWith(join("routes", "matchmaking.ts")), `${f} reads the clock or random`).toBe(false);
    }
  });
});
