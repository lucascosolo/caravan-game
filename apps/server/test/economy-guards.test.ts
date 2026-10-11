/**
 * Chunk 16 guardrail tests that need no database: the pay-to-win bound on merging, the
 * recipe and cost arithmetic, the earn schedule, the trickle math, and a source-level
 * check that nothing in the economy code can see what an account has paid for.
 */
import { FIXED_POINT_SCALE, LIVING_UNIT_TYPES, TUNABLES, scaleInt, type Fixed } from "@caravan/content";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bandOf } from "../src/matchmaking/band.js";
import { coinForBankedTrip, coinForDelivery, coinForEncounter, coinForEncountersSurvived, encounterCoinSchedule, overflowForecast } from "../src/economy/coin.js";
import { MERGE_RECIPES, mergeCost, mergeCostTable, recipeForCount, statsAtLevel } from "../src/economy/merge.js";
import { computeTrickle } from "../src/economy/trickle.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("merging is slot efficiency, never a power gain (GUARDRAILS §2)", () => {
  const defenses = LIVING_UNIT_TYPES.map((u) => u.defense);
  const opponents = [...new Set([Math.min(...defenses), Math.max(...defenses), ...defenses])];

  it("at every level and for both recipes, produced strength < consumed strength, for every unit type vs every defense", () => {
    expect(MERGE_RECIPES.map((r) => [r.spend, r.produce])).toEqual([
      [2, 1],
      [5, 3],
    ]);
    let checks = 0;
    for (const unit of LIVING_UNIT_TYPES) {
      for (let from = TUNABLES.MERGE_LEVEL_MIN; from < TUNABLES.MERGE_LEVEL_MAX; from++) {
        const before = statsAtLevel(unit, from);
        const after = statsAtLevel(unit, from + 1);
        // Ratings never move with merge level.
        expect(after.offense).toBe(unit.offense);
        expect(after.defense).toBe(unit.defense);
        for (const def of opponents) {
          const hitBefore = scaleInt(Math.floor((unit.offense * unit.offense) / (unit.offense + def)), before.damageOutputMult as Fixed);
          const hitAfter = scaleInt(Math.floor((unit.offense * unit.offense) / (unit.offense + def)), after.damageOutputMult as Fixed);
          for (const r of MERGE_RECIPES) {
            const consumed = r.spend * before.hp * hitBefore;
            const produced = r.produce * after.hp * hitAfter;
            expect(produced, `${unit.id} L${from}->L${from + 1} ${r.spend}->${r.produce} vs def ${def}`).toBeLessThan(consumed);
            // And HP alone, and hit alone, never exceed the components combined either.
            expect(r.produce * after.hp).toBeLessThan(r.spend * before.hp);
            expect(r.produce * hitAfter).toBeLessThanOrEqual(r.spend * hitBefore);
            checks++;
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(0);
  });

  it("a merged unit costs exactly one slot at every level; 5→3 frees two, 2→1 frees one", () => {
    expect(TUNABLES.MERGE_SLOT_COST).toBe(1);
    expect(recipeForCount(2)).toEqual({ spend: 2, produce: 1 });
    expect(recipeForCount(5)).toEqual({ spend: 5, produce: 3 });
    for (const n of [0, 1, 3, 4, 6, 10]) expect(recipeForCount(n)).toBeNull();
  });

  it("the large recipe is the better per-level rate (rewards hoarding): 1.67 < 2.0 units per level", () => {
    // spend/produce units consumed per unit produced per level.
    expect(5 * 1 < 2 * 3).toBe(true); // 5/3 < 2/1, cross-multiplied — no floats needed
  });

  it("the merge cap is the content cap and nothing in the economy can raise it", () => {
    expect(TUNABLES.MERGE_LEVEL_MAX).toBe(5);
    expect(() => mergeCost(6, 1)).toThrow(RangeError);
    expect(() => mergeCost(1, 1)).toThrow(RangeError);
  });
});

describe("merge cost arithmetic", () => {
  it("cost is per resulting unit, by target level", () => {
    expect(mergeCostTable()).toEqual({ 2: 250, 3: 900, 4: 3000, 5: 9500 });
    expect(mergeCost(2, 1)).toBe(250);
    expect(mergeCost(2, 3)).toBe(750);
    expect(mergeCost(5, 3)).toBe(28_500);
  });

  it("one level-5 unit from sixteen level-1 units via 2→1 costs 21,100 Coin, below the storage cap", () => {
    const total = 8 * mergeCost(2, 1) + 4 * mergeCost(3, 1) + 2 * mergeCost(4, 1) + 1 * mergeCost(5, 1);
    expect(total).toBe(21_100);
    expect(total).toBeLessThan(TUNABLES.COIN_STORAGE_CAP);
    // A single most expensive merge (5→3 to level 5) also fits under the cap.
    expect(mergeCost(5, 3)).toBeLessThan(TUNABLES.COIN_STORAGE_CAP);
  });
});

describe("earn schedule", () => {
  it("is an integer table: 400 × 1.35 per encounter, floored; delivery is 125 × encounters survived (chunk 15 QA D1) — band 0 is the base", () => {
    expect(encounterCoinSchedule(8, 0)).toEqual([400, 539, 727, 981, 1323, 1785, 2409, 3251]);
    expect(coinForEncounter(1, 0)).toBe(400);
    expect(coinForEncounter(4, 0)).toBe(981);
    expect(coinForEncountersSurvived(0, 0)).toBe(0);
    expect(coinForEncountersSurvived(3, 0)).toBe(1666);
    expect(TUNABLES.COIN_DELIVERY_PER_ENCOUNTER).toBe(125);
    expect(coinForDelivery(3)).toBe(375);
    expect(coinForBankedTrip(1, 0)).toBe(525);
    expect(coinForBankedTrip(3, 0)).toBe(1666 + 375);
    expect(() => coinForEncounter(0, 0)).toThrow(RangeError);
    expect(TUNABLES.COIN_ENCOUNTER_ESCALATION_MULT).toBe(1382); // 1.35 in 1/1024ths, truncated (≈ 1.3496)
    expect(FIXED_POINT_SCALE).toBe(1024);
  });

  it("chunk 19 QA D2a: encounter Coin scales with the living display band, +COIN_ENCOUNTER_BAND_SCALE_BP per band, floored; the delivery does not", () => {
    expect(TUNABLES.COIN_ENCOUNTER_BAND_SCALE_BP).toBe(5000);
    // REPUTATION_START (1000) is display band 3: × 2.5.
    expect(bandOf(TUNABLES.REPUTATION_START).index).toBe(3);
    expect(encounterCoinSchedule(5, 3)).toEqual([1000, 1347, 1817, 2452, 3307]);
    expect(encounterCoinSchedule(3, 1)).toEqual([600, 808, 1090]);
    for (let band = 0; band <= 12; band++) {
      const base = encounterCoinSchedule(30, 0);
      const scaled = encounterCoinSchedule(30, band);
      scaled.forEach((c, i) => {
        expect(c).toBe(Math.min(TUNABLES.COIN_STORAGE_CAP, Math.floor((base[i]! * (10_000 + band * 5000)) / 10_000)));
        expect(Number.isSafeInteger(c)).toBe(true);
        expect(coinForEncounter(i + 1, band)).toBe(c);
      });
      // Higher bands never pay less, at any encounter.
      if (band > 0) encounterCoinSchedule(30, band - 1).forEach((c, i) => expect(scaled[i]!).toBeGreaterThanOrEqual(c));
      expect(coinForBankedTrip(2, band) - coinForEncountersSurvived(2, band)).toBe(coinForDelivery(2));
    }
    expect(() => coinForEncounter(1, -1)).toThrow(RangeError);
    expect(() => coinForEncounter(1, 1.5)).toThrow(RangeError);
  });

  it("N4: the schedule clamps at the storage cap and never leaves the safe-integer range", () => {
    expect(coinForEncounter(200, 0)).toBe(TUNABLES.COIN_STORAGE_CAP);
    expect(coinForEncounter(200, 40)).toBe(TUNABLES.COIN_STORAGE_CAP);
    for (const band of [0, 3, 40]) {
      const schedule = encounterCoinSchedule(300, band);
      expect(schedule.every((n) => Number.isSafeInteger(n) && n <= TUNABLES.COIN_STORAGE_CAP)).toBe(true);
      expect(schedule.indexOf(TUNABLES.COIN_STORAGE_CAP)).toBeGreaterThan(0);
      expect(Number.isSafeInteger(coinForEncountersSurvived(300, band))).toBe(true);
      // Below the clamp the table is unchanged.
      expect(schedule.slice(0, 8)).toEqual(encounterCoinSchedule(8, band));
    }
  });

  it("the passive path pays less than one survived encounter (playing pays better than not playing)", () => {
    expect(TUNABLES.COIN_PER_PARTY_WIN).toBeLessThan(coinForEncounter(1, 0));
  });

  it("overflow forecast: what the cap would discard, for the pre-trip warning", () => {
    expect(overflowForecast(49_000, 50_000, 3_782)).toMatchObject({ room: 1000, wouldCredit: 1000, wouldDiscard: 2782, atCap: false });
    expect(overflowForecast(50_000, 50_000, 10)).toMatchObject({ room: 0, wouldCredit: 0, wouldDiscard: 10, atCap: true });
    expect(overflowForecast(0, 50_000, 10)).toMatchObject({ wouldDiscard: 0, atCap: false });
  });
});

describe("trickle math is pure, exact and read-frequency independent", () => {
  const MS = TUNABLES.COIN_TRICKLE_MS_PER_COIN;

  it("rate and ms-per-coin agree", () => {
    expect(TUNABLES.COIN_TRICKLE_RATE_PER_HOUR * TUNABLES.COIN_TRICKLE_MS_PER_COIN).toBe(3_600_000);
  });

  it("one read after an hour == 200 coins; 3600 one-second reads == the same 200 coins", () => {
    const once = computeTrickle({ accruedFromMs: 0, nowMs: 3_600_000, balance: 0, cap: 50_000 });
    expect(once.coins).toBe(200);
    expect(once.accruedThroughMs).toBe(3_600_000);
    let from = 0;
    let balance = 0;
    for (let t = 1000; t <= 3_600_000; t += 1000) {
      const c = computeTrickle({ accruedFromMs: from, nowMs: t, balance, cap: 50_000 });
      balance += c.credited;
      from = c.accruedThroughMs;
    }
    expect(balance).toBe(200);
    // Irregular read times, remainder carried: 7-second reads over an hour still total 200.
    from = 0;
    balance = 0;
    for (let t = 7000; t <= 3_600_000; t += 7000) {
      const c = computeTrickle({ accruedFromMs: from, nowMs: t, balance, cap: 50_000 });
      balance += c.credited;
      from = c.accruedThroughMs;
    }
    const finalRead = computeTrickle({ accruedFromMs: from, nowMs: 3_600_000, balance, cap: 50_000 });
    expect(balance + finalRead.credited).toBe(200);
  });

  it("sub-coin elapsed time writes nothing and carries the remainder", () => {
    const c = computeTrickle({ accruedFromMs: 0, nowMs: MS - 1, balance: 0, cap: 50_000 });
    expect(c.coins).toBe(0);
    expect(c.accruedThroughMs).toBe(0);
    expect(c.nextCoinInMs).toBe(1);
  });

  it("ceases at the cap: discards are recorded and no backlog is banked", () => {
    const c = computeTrickle({ accruedFromMs: 0, nowMs: 10 * MS, balance: 49_995, cap: 50_000 });
    expect(c).toMatchObject({ coins: 10, credited: 5, discarded: 5, accruedThroughMs: 10 * MS });
    const atCap = computeTrickle({ accruedFromMs: 0, nowMs: 1_000 * MS, balance: 50_000, cap: 50_000 });
    expect(atCap).toMatchObject({ coins: 1000, credited: 0, discarded: 1000, accruedThroughMs: 1_000 * MS });
    // After a spend, the clock restarts from the last read, not from account creation.
    const after = computeTrickle({ accruedFromMs: atCap.accruedThroughMs, nowMs: 1_000 * MS + 2 * MS, balance: 40_000, cap: 50_000 });
    expect(after.coins).toBe(2);
  });

  it("S4: materializes only at the coin or time threshold, never at the cap, and the thresholds drop nothing", () => {
    const minCoins = TUNABLES.TRICKLE_MATERIALIZE_MIN_COINS;
    expect(computeTrickle({ accruedFromMs: 0, nowMs: (minCoins - 1) * MS, balance: 0, cap: 50_000 }).shouldMaterialize).toBe(false);
    expect(computeTrickle({ accruedFromMs: 0, nowMs: minCoins * MS, balance: 0, cap: 50_000 }).shouldMaterialize).toBe(true);
    expect(computeTrickle({ accruedFromMs: 0, nowMs: TUNABLES.TRICKLE_MATERIALIZE_MIN_MS, balance: 0, cap: 50_000 }).shouldMaterialize).toBe(true);
    // At the cap there is nothing to credit, so nothing to write — however long it has been.
    expect(computeTrickle({ accruedFromMs: 0, nowMs: 1_000 * MS, balance: 50_000, cap: 50_000 }).shouldMaterialize).toBe(false);
    // Partial room still writes once the threshold is met (the discard is recorded on that row).
    expect(computeTrickle({ accruedFromMs: 0, nowMs: minCoins * MS, balance: 49_999, cap: 50_000 })).toMatchObject({ credited: 1, discarded: minCoins - 1, shouldMaterialize: true });
    // Reads below the threshold carry the pending coins forward: ledger + pending is always the full amount.
    let from = 0;
    let ledger = 0;
    let shown = 0;
    for (let t = MS; t <= 100 * MS; t += MS) {
      const c = computeTrickle({ accruedFromMs: from, nowMs: t, balance: ledger, cap: 50_000 });
      shown = ledger + c.credited;
      if (c.shouldMaterialize) {
        ledger += c.credited;
        from = c.accruedThroughMs;
      }
      expect(shown).toBe(t / MS);
    }
    expect(ledger).toBe(100);
  });

  it("a clock that goes backwards credits nothing", () => {
    expect(computeTrickle({ accruedFromMs: 5_000_000, nowMs: 1_000, balance: 0, cap: 50_000 }).coins).toBe(0);
  });

  it("refuses non-integer inputs (no float drift can enter)", () => {
    expect(() => computeTrickle({ accruedFromMs: 0, nowMs: 1.5, balance: 0, cap: 10 })).toThrow(RangeError);
  });
});

describe("nothing in the economy can see what an account has paid for (GUARDRAILS §2)", () => {
  it("economy sources reference no entitlement, billing or pack concepts and no coin_purchased event", () => {
    const dir = join(HERE, "..", "src", "economy");
    const files = readdirSync(dir).map((f) => join(dir, f));
    files.push(join(HERE, "..", "src", "routes", "economy.ts"));
    const banned = /purchas|entitle|billing|premium|subscri|stripe|payment|\bpaid\b|\biap\b|\bpack\b|coin_purchased/i;
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (banned.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("S5: `coinDebitDraft` is imported only by economy/coin.ts — `spendCoin` is the only debit path", () => {
    const src = join(HERE, "..", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : []));
    const importers = walk(src).filter((f) => /import\s[^;]*\bcoinDebitDraft\b[^;]*from/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => f.slice(src.length + 1))).toEqual(["economy/coin.ts"]);
    // And nothing outside the economy module writes a `coin_spent` draft by hand. (Chunk 32: src/analytics/ only READS
    // the ledger — its SQL filters on the type; telemetry.test.ts proves it appends nothing.)
    const spenders = walk(src).filter((f) => !f.includes("/economy/") && !f.includes("/analytics/") && !f.endsWith("ledger/coin.ts") && !f.endsWith("ledger/events.ts") && /["']coin_spent["']/.test(readFileSync(f, "utf8")));
    expect(spenders).toEqual([]);
  });

  it("economy sources never read account columns beyond Coin and identity", () => {
    const dir = join(HERE, "..", "src", "economy");
    const src = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    // Every account read names its columns explicitly; none is a SELECT * on account.
    expect(src).not.toMatch(/SELECT \* FROM account/i);
    const accountSelects = src.match(/SELECT [^;]*? FROM account\b/gi) ?? [];
    expect(accountSelects.length).toBeGreaterThan(0);
    for (const sel of accountSelects) {
      const cols = sel.replace(/^SELECT /i, "").replace(/ FROM account\b.*$/i, "");
      // `is_system` (chunk 25) is the non-player flag every credit path refuses on; it is not a purchase or entitlement.
      expect(cols).toMatch(/^(coin_balance, coin_storage_cap(, is_system)?|coin_balance|1|\(floor\(extract\(epoch FROM created_at\) \* 1000\)\)::text AS created_ms)$/);
    }
  });
});
