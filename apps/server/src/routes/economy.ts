/**
 * Economy routes (chunk 16). Reading the balance materializes the lazy trickle; the merge
 * preview is the legibility contract (cost, resulting stats, slots — before commit).
 */
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { encounterCoinSchedule, overflowForecast } from "../economy/coin.js";
import { mergeCostTable, performMerge, previewMerge } from "../economy/merge.js";
import { accrueTrickle } from "../economy/trickle.js";
import { badRequest } from "../services/errors.js";
import { requireAuth } from "./require-auth.js";

/** How many encounters of the earn schedule the overview shows. Presentation, not balance. */
const SCHEDULE_PREVIEW_LENGTH = 10;

export async function economyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The account's Coin, with the trickle accrued as of now. `?prospectiveEarn=N` returns
   * the overflow forecast for a trip expected to earn N — the warning before the trip.
   */
  app.get<{ Querystring: { prospectiveEarn?: string } }>("/me/economy", { preHandler: requireAuth }, async (req) => {
    const account = req.auth!.account;
    const prospectiveRaw = req.query.prospectiveEarn;
    const prospectiveEarn = prospectiveRaw === undefined ? 0 : Number(prospectiveRaw);
    if (!Number.isInteger(prospectiveEarn) || prospectiveEarn < 0) {
      throw badRequest("invalid_prospective_earn", "prospectiveEarn must be a non-negative integer");
    }
    const trickle = await accrueTrickle(app.db, account.id);
    const forecast = overflowForecast(trickle.balance, trickle.cap, prospectiveEarn);
    return {
      balance: trickle.balance,
      cap: trickle.cap,
      room: forecast.room,
      atCap: trickle.atCap,
      trickle: {
        ratePerHour: trickle.ratePerHour,
        msPerCoin: trickle.msPerCoin,
        creditedNow: trickle.credited,
        discardedNow: trickle.discarded,
        nextCoinInMs: trickle.atCap ? null : trickle.nextCoinInMs,
        accruedThroughMs: trickle.accruedThroughMs,
      },
      overflow: {
        behavior: TUNABLES.COIN_OVERFLOW_BEHAVIOR,
        prospectiveEarn: forecast.prospectiveEarn,
        wouldCredit: forecast.wouldCredit,
        wouldDiscard: forecast.wouldDiscard,
        warn: forecast.wouldDiscard > 0,
      },
      earn: {
        encounterSchedule: encounterCoinSchedule(SCHEDULE_PREVIEW_LENGTH),
        bankedTripBonus: TUNABLES.COIN_PER_BANKED_TRIP,
        partyWin: TUNABLES.COIN_PER_PARTY_WIN,
      },
      merge: {
        costPerResultingUnitByLevel: mergeCostTable(),
        recipes: TUNABLES.MERGE_RECIPES,
        levelCap: TUNABLES.MERGE_LEVEL_MAX,
        slotCost: TUNABLES.MERGE_SLOT_COST,
      },
    };
  });

  app.post<{ Params: { caravanId: string }; Body: { instanceIds?: unknown } }>(
    "/me/caravans/:caravanId/merge/preview",
    { preHandler: requireAuth },
    async (req) => previewMerge(app.db, { accountId: req.auth!.account.id, caravanId: req.params.caravanId, instanceIds: req.body?.instanceIds }),
  );

  app.post<{ Params: { caravanId: string }; Body: { instanceIds?: unknown } }>(
    "/me/caravans/:caravanId/merge",
    { preHandler: requireAuth },
    async (req) => {
      const result = await performMerge(app.db, { accountId: req.auth!.account.id, caravanId: req.params.caravanId, instanceIds: req.body?.instanceIds });
      return {
        preview: result.preview,
        consumedInstanceIds: result.consumedIds,
        produced: result.produced,
        balanceAfter: result.balanceAfter,
        events: result.events.map((e) => ({ seq: e.seq, type: e.event_type, payload: e.payload })),
      };
    },
  );
}
