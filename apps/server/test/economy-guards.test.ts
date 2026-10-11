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
import { coinForBankedTrip, coinForEncounter, coinForEncountersSurvived, encounterCoinSchedule, overflowForecast } from "../src/economy/coin.js";
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
  it("is an integer table: 400 × 1.25 per encounter, floored", () => {
    expect(encounterCoinSchedule(8)).toEqual([400, 500, 625, 781, 976, 1220, 1525, 1906]);
    expect(coinForEncounter(1)).toBe(400);
    expect(coinForEncounter(4)).toBe(781);
    expect(coinForEncountersSurvived(0)).toBe(0);
    expect(coinForEncountersSurvived(3)).toBe(1525);
    expect(coinForBankedTrip(3)).toBe(1525 + TUNABLES.COIN_PER_BANKED_TRIP);
    expect(() => coinForEncounter(0)).toThrow(RangeError);
    expect(TUNABLES.COIN_ENCOUNTER_ESCALATION_MULT).toBe(1280); // exactly 1.25 in 1/1024ths
    expect(FIXED_POINT_SCALE).toBe(1024);
  });

  it("the passive path pays less than one survived encounter (playing pays better than not playing)", () => {
    expect(TUNABLES.COIN_PER_PARTY_WIN).toBeLessThan(coinForEncounter(1));
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
      expect(cols).toMatch(/^(coin_balance, coin_storage_cap|coin_balance|1|\(floor\(extract\(epoch FROM created_at\) \* 1000\)\)::text AS created_ms)$/);
    }
  });
});
