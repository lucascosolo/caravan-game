import { describe, expect, it } from "vitest";
import { TUNABLES } from "@caravan/content";
import { ACCOUNT_ID, CARAVAN_ID, DEFAULT_NOW, buildEconomyHarness } from "./fixtures.js";
import { InsufficientCoinError, AccountNotFoundError } from "../services/coinService.js";

describe("CoinService", () => {
  describe("credit", () => {
    it("credits coins and writes a ledger event", () => {
      const h = buildEconomyHarness({ initialCoin: 0 });
      const result = h.coinService.credit(ACCOUNT_ID, 1000, "encounter", "cause_1", DEFAULT_NOW);
      expect(result.newBalance).toBe(1000);
      expect(result.applied).toBe(1000);
      expect(result.discarded).toBe(0);
      expect(h.accountRepo.get(ACCOUNT_ID)!.coinBalance).toBe(1000);
      const events = h.ledgerRepo.listByAccount(ACCOUNT_ID);
      expect(events.length).toBe(1);
      expect(events[0]!.kind).toBe("coin_earned");
      if (events[0]!.kind === "coin_earned") {
        expect(events[0]!.amountApplied).toBe(1000);
        expect(events[0]!.source).toBe("encounter");
      }
    });

    it("discards overflow above storage cap with a warning event", () => {
      const h = buildEconomyHarness({ initialCoin: TUNABLES.COIN_STORAGE_CAP - 100 });
      const result = h.coinService.credit(ACCOUNT_ID, 200, "encounter", "cause_1", DEFAULT_NOW);
      expect(result.applied).toBe(100);
      expect(result.discarded).toBe(100);
      expect(result.newBalance).toBe(TUNABLES.COIN_STORAGE_CAP);
      // Should have a coin_earned + a coin_overflow_discarded event
      const events = h.ledgerRepo.listByAccount(ACCOUNT_ID);
      const overflowEvents = events.filter((e) => e.kind === "coin_overflow_discarded");
      expect(overflowEvents.length).toBe(1);
      if (overflowEvents[0]!.kind === "coin_overflow_discarded") {
        expect(overflowEvents[0]!.amountDiscarded).toBe(100);
      }
    });

    it("throws for non-existent account", () => {
      const h = buildEconomyHarness();
      expect(() => h.coinService.credit("nonexistent", 100, "encounter", "c", DEFAULT_NOW)).toThrow(
        AccountNotFoundError,
      );
    });
  });

  describe("debit", () => {
    it("deducts coins and writes a spend event", () => {
      const h = buildEconomyHarness({ initialCoin: 1000 });
      const result = h.coinService.debit(ACCOUNT_ID, 250, "merge", "cause_1", DEFAULT_NOW);
      expect(result).toBe(750);
      const events = h.ledgerRepo.listByAccount(ACCOUNT_ID);
      const spendEvents = events.filter((e) => e.kind === "coin_spent");
      expect(spendEvents.length).toBe(1);
    });

    it("throws InsufficientCoinError when balance is too low", () => {
      const h = buildEconomyHarness({ initialCoin: 100 });
      expect(() => h.coinService.debit(ACCOUNT_ID, 250, "merge", "c", DEFAULT_NOW)).toThrow(
        InsufficientCoinError,
      );
    });
  });

  describe("getBalance", () => {
    it("returns the current balance", () => {
      const h = buildEconomyHarness({ initialCoin: 5000 });
      expect(h.coinService.getBalance(ACCOUNT_ID)).toBe(5000);
    });

    it("throws for non-existent account", () => {
      const h = buildEconomyHarness();
      expect(() => h.coinService.getBalance("nonexistent")).toThrow(AccountNotFoundError);
    });
  });

  describe("computeAndApplyTrickle", () => {
    it("credits trickle coins based on elapsed time since cursor", () => {
      const h = buildEconomyHarness({ initialCoin: 0, trickleCursor: DEFAULT_NOW });
      const later = "2026-01-01T03:00:00.000Z"; // 3 hours later
      const result = h.coinService.computeAndApplyTrickle(ACCOUNT_ID, later);
      // 200/hour × 3h = 600
      expect(result.applied).toBe(600);
      expect(result.newBalance).toBe(600);
      expect(h.accountRepo.get(ACCOUNT_ID)!.coinLastTrickleAt).toBe("2026-01-01T03:00:00.000Z");
    });

    it("returns 0 when no time has elapsed", () => {
      const h = buildEconomyHarness({ initialCoin: 500, trickleCursor: DEFAULT_NOW });
      const result = h.coinService.computeAndApplyTrickle(ACCOUNT_ID, DEFAULT_NOW);
      expect(result.applied).toBe(0);
      expect(result.newBalance).toBe(500);
    });

    it("advances cursor only by whole trickle multiples", () => {
      const h = buildEconomyHarness({ initialCoin: 0, trickleCursor: DEFAULT_NOW });
      // 2h18m (8,280,000ms). MS_PER_TRICKLE_COIN = 3,600,000 / 200 = 18,000.
      // 8,280,000 / 18,000 = 460 coins exactly (460 * 18,000 = 8,280,000)
      // To test remainder: 2h18m20s = 8,300,000ms → 8,300,000 / 18,000 = 461.11...
      // = 461 full coins * 18,000 = 8,298,000ms consumed, 2,000ms carried as remainder
      const later = "2026-01-01T02:18:20.000Z";
      const result = h.coinService.computeAndApplyTrickle(ACCOUNT_ID, later);
      expect(result.applied).toBe(461); // 461 full coins
      expect(result.newBalance).toBe(461);
      // Cursor advanced by 461 * 18,000ms = 8,298,000ms from epoch
      // 8,298,000ms = 2h18m18s
      expect(h.accountRepo.get(ACCOUNT_ID)!.coinLastTrickleAt).toBe("2026-01-01T02:18:18.000Z");
    });

    it("cears at the storage cap", () => {
      const h = buildEconomyHarness({
        initialCoin: TUNABLES.COIN_STORAGE_CAP - 100,
        trickleCursor: DEFAULT_NOW,
      });
      const later = "2026-01-01T03:00:00.000Z"; // 3h, would earn 600
      const result = h.coinService.computeAndApplyTrickle(ACCOUNT_ID, later);
      // Only 100 fits (cap reached)
      expect(result.applied).toBe(100);
      expect(result.applied + result.discarded).toBe(600);
      expect(result.newBalance).toBe(TUNABLES.COIN_STORAGE_CAP);
    });
  });

  describe("creditEncounterReward", () => {
    it("credits base reward for encounter 1, escalating for subsequent", () => {
      const h = buildEconomyHarness({ initialCoin: 0 });
      const r1 = h.coinService.creditEncounterReward(ACCOUNT_ID, 1, "trip_1", DEFAULT_NOW);
      expect(r1.applied).toBe(TUNABLES.COIN_PER_ENCOUNTER_BASE);
      const r2 = h.coinService.creditEncounterReward(ACCOUNT_ID, 2, "trip_1", DEFAULT_NOW);
      const expected = Math.trunc((TUNABLES.COIN_PER_ENCOUNTER_BASE * TUNABLES.COIN_PER_ENCOUNTER_MULT_MILLI) / 1000);
      expect(r2.applied).toBe(expected);
    });
  });

  describe("creditBankedTrip", () => {
    it("credits the flat completion bonus", () => {
      const h = buildEconomyHarness({ initialCoin: 0 });
      const result = h.coinService.creditBankedTrip(ACCOUNT_ID, "trip_1", DEFAULT_NOW);
      expect(result.applied).toBe(TUNABLES.COIN_PER_BANKED_TRIP);
    });
  });

  describe("creditPartyWin", () => {
    it("credits the party win reward", () => {
      const h = buildEconomyHarness({ initialCoin: 0 });
      const result = h.coinService.creditPartyWin(ACCOUNT_ID, "party_1", DEFAULT_NOW);
      expect(result.applied).toBe(TUNABLES.COIN_PER_PARTY_WIN);
    });
  });
});