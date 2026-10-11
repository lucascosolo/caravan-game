/**
 * Economy routes (chunk 16). Reading the balance computes the lazy trickle (and
 * materializes it once enough has accrued — QA S4); the merge preview is the legibility
 * contract (cost, resulting stats, slots — before commit). Path and body validation
 * happens in the economy module before any query (QA S3, N2); the route only parses.
 */
import { TUNABLES } from "@caravan/content";
import type { FastifyInstance } from "fastify";
import { encounterCoinSchedule, overflowForecast } from "../economy/coin.js";
import { UnitInPartyError, UnitPackedError, mergeCostTable, performMerge, previewMerge } from "../economy/merge.js";
import { accrueTrickle } from "../economy/trickle.js";
import { badRequest } from "../services/errors.js";
import { requireAuth } from "./require-auth.js";

/** How many encounters of the earn schedule the overview shows. Presentation, not balance. */
const SCHEDULE_PREVIEW_LENGTH = 10;

/** `prospectiveEarn` may not exceed this many storage caps (QA N1): no trip is worth more. */
const PROSPECTIVE_EARN_MAX_CAPS = 10;

export async function economyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The account's Coin, with the trickle computed as of now. `?prospectiveEarn=N` returns
   * the overflow forecast for a trip expected to earn N — the warning before the trip. The
   * forecast is "as of now": `room` is the room RIGHT NOW, and the trickle keeps filling
   * the store while the trip runs (QA N5).
   */
  app.get<{ Querystring: { prospectiveEarn?: unknown } }>("/me/economy", { preHandler: requireAuth }, async (req) => {
    const account = req.auth!.account;
    const prospectiveRaw = req.query.prospectiveEarn;
    const prospectiveEarn = prospectiveRaw === undefined ? 0 : typeof prospectiveRaw === "string" && /^\d{1,16}$/.test(prospectiveRaw) ? Number(prospectiveRaw) : NaN;
    if (!Number.isSafeInteger(prospectiveEarn) || prospectiveEarn < 0) {
      throw badRequest("invalid_prospective_earn", "prospectiveEarn must be a non-negative integer");
    }
    const trickle = await accrueTrickle(app.db, account.id);
    if (prospectiveEarn > PROSPECTIVE_EARN_MAX_CAPS * trickle.cap) {
      throw badRequest("invalid_prospective_earn", `prospectiveEarn may not exceed ${PROSPECTIVE_EARN_MAX_CAPS} × the storage cap`);
    }
    const forecast = overflowForecast(trickle.balance, trickle.cap, prospectiveEarn);
    return {
      /** Ledger balance plus the trickle pending right now — what the player has. */
      balance: trickle.balance,
      cap: trickle.cap,
      room: forecast.room,
      atCap: trickle.atCap,
      trickle: {
        ratePerHour: trickle.ratePerHour,
        msPerCoin: trickle.msPerCoin,
        /** Accrued but not yet written to the ledger; already part of `balance`. */
        pending: trickle.pending,
        ledgerBalance: trickle.ledgerBalance,
        materializedNow: trickle.materialized,
        creditedNow: trickle.materialized ? trickle.credited : 0,
        discardedNow: trickle.materialized ? trickle.discarded : 0,
        nextCoinInMs: trickle.atCap ? null : trickle.nextCoinInMs,
        accruedThroughMs: trickle.accruedThroughMs,
      },
      overflow: {
        behavior: TUNABLES.COIN_OVERFLOW_BEHAVIOR,
        prospectiveEarn: forecast.prospectiveEarn,
        wouldCredit: forecast.wouldCredit,
        wouldDiscard: forecast.wouldDiscard,
        warn: forecast.wouldDiscard > 0,
        message:
          forecast.wouldDiscard > 0
            ? `Your store has room for ${forecast.room} more Coin right now; ${forecast.wouldDiscard} of the ${forecast.prospectiveEarn} this trip could earn would be discarded at the cap.`
            : `Your store has room for ${forecast.room} more Coin right now.`,
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
    async (req) => previewMerge(app.db, { accountId: req.auth!.account.id, caravanId: req.params.caravanId, instanceIds: bodyIds(req.body) }),
  );

  /**
   * Commit. Chunk 09 QA S3: when a consumed unit rides in the standing party the commit
   * is refused with 409 `unit_in_party` (the preview says so in `consumed.inParty`) unless
   * the body carries `confirmInParty: true`.
   */
  app.post<{ Params: { caravanId: string }; Body: { instanceIds?: unknown; confirmInParty?: unknown } }>(
    "/me/caravans/:caravanId/merge",
    { preHandler: requireAuth },
    async (req) => {
      const result = await performMerge(app.db, {
        accountId: req.auth!.account.id,
        caravanId: req.params.caravanId,
        instanceIds: bodyIds(req.body),
        confirmInParty: bodyConfirmInParty(req.body),
      });
      return {
        /** True => this exact merge had already committed; the stored outcome is returned and nothing moved. */
        replayed: result.replayed,
        preview: result.preview,
        merged: result.merged,
        consumedInstanceIds: result.consumedIds,
        producedInstanceIds: result.producedIds,
        produced: result.produced,
        balanceAfter: result.balanceAfter,
        events: result.events.map((e) => ({ seq: e.seq, type: e.event_type, payload: e.payload })),
      };
    },
  );

  // The 409 names the instances so the client can show which party slots would empty.
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof UnitInPartyError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, inParty: err.inParty });
    }
    if (err instanceof UnitPackedError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, packed: err.packed });
    }
    throw err;
  });
}

/** The body may be anything JSON (an array, a string, null); only an object's `instanceIds` counts. */
function bodyIds(body: unknown): unknown {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as { instanceIds?: unknown }).instanceIds : undefined;
}

/** Only the literal boolean `true` confirms; anything else is "not confirmed". */
function bodyConfirmInParty(body: unknown): boolean {
  return body !== null && typeof body === "object" && !Array.isArray(body) && (body as { confirmInParty?: unknown }).confirmInParty === true;
}
