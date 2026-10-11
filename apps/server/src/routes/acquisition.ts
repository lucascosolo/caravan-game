/**
 * Unit acquisition routes (chunk 18).
 *
 *   GET  /me/caravans/:caravanId/refugees         the current menu, the free timer, the next
 *                                                 reroll cost, balance — everything before commit
 *   POST /me/caravans/:caravanId/refugees/claim   { unitTypeId, sequence } — take one offer
 *   POST /me/caravans/:caravanId/refugees/refresh { fromSequence } — take the due free menu (free)
 *   POST /me/caravans/:caravanId/refugees/reroll  { fromSequence } — Coin for a sooner menu
 *   GET  /me/caravans/:caravanId/recruit          the price list: every unlocked type at its cost,
 *                                                 and the locked ones (shown, never sold)
 *   POST /me/caravans/:caravanId/recruit          { unitTypeId, requestId? } — buy one level-1 copy
 *
 * `sequence` / `fromSequence` are required on every mutating refugee route (chunk 18 QA S1):
 * the GET supplies them as `menu.sequence`. The GET itself never writes past the caravan's
 * first menu (QA D1/S2).
 *
 * The route only parses; validation and the access gate live in src/acquisition. The wall
 * clock enters here (Date.now()) and is passed down as `nowMs`.
 */
import type { FastifyInstance } from "fastify";
import { bodyObject } from "../acquisition/grant.js";
import { recruitMercenary, viewRecruit } from "../acquisition/recruit.js";
import { claimRefugee, refreshRefugees, rerollRefugees, viewRefugees } from "../acquisition/refugees.js";
import type { LedgerEventRow } from "../ledger/events.js";
import { requireAuth } from "./require-auth.js";

const eventsOut = (events: readonly LedgerEventRow[]) => events.map((e) => ({ seq: e.seq, type: e.event_type, payload: e.payload }));

export async function acquisitionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { caravanId: string } }>("/me/caravans/:caravanId/refugees", { preHandler: requireAuth }, async (req) =>
    viewRefugees(app.db, { accountId: req.auth!.account.id, caravanId: req.params.caravanId, nowMs: Date.now() }),
  );

  app.post<{ Params: { caravanId: string } }>("/me/caravans/:caravanId/refugees/claim", { preHandler: requireAuth }, async (req, reply) => {
    const body = bodyObject(req.body);
    const result = await claimRefugee(app.db, {
      accountId: req.auth!.account.id,
      caravanId: req.params.caravanId,
      unitTypeId: body["unitTypeId"],
      sequence: body["sequence"],
      nowMs: Date.now(),
    });
    return reply.code(result.replayed ? 200 : 201).send({
      replayed: result.replayed,
      acquired: result.acquired,
      instance: result.instance,
      events: eventsOut(result.events),
      refugees: result.view,
    });
  });

  app.post<{ Params: { caravanId: string } }>("/me/caravans/:caravanId/refugees/refresh", { preHandler: requireAuth }, async (req, reply) => {
    const body = bodyObject(req.body);
    const result = await refreshRefugees(app.db, {
      accountId: req.auth!.account.id,
      caravanId: req.params.caravanId,
      fromSequence: body["fromSequence"],
      nowMs: Date.now(),
    });
    return reply.code(result.replayed ? 200 : 201).send({
      replayed: result.replayed,
      fromSequence: result.fromSequence,
      produced: result.produced,
      forfeitedOffers: result.forfeitedOffers,
      refugees: result.view,
    });
  });

  app.post<{ Params: { caravanId: string } }>("/me/caravans/:caravanId/refugees/reroll", { preHandler: requireAuth }, async (req, reply) => {
    const body = bodyObject(req.body);
    const result = await rerollRefugees(app.db, {
      accountId: req.auth!.account.id,
      caravanId: req.params.caravanId,
      fromSequence: body["fromSequence"],
      nowMs: Date.now(),
    });
    return reply.code(result.replayed ? 200 : 201).send({
      replayed: result.replayed,
      fromSequence: result.fromSequence,
      produced: result.produced,
      coinCost: result.coinCost,
      balanceAfter: result.balanceAfter,
      events: eventsOut(result.events),
      refugees: result.view,
    });
  });

  app.get<{ Params: { caravanId: string } }>("/me/caravans/:caravanId/recruit", { preHandler: requireAuth }, async (req) =>
    viewRecruit(app.db, { accountId: req.auth!.account.id, caravanId: req.params.caravanId, nowMs: Date.now() }),
  );

  app.post<{ Params: { caravanId: string } }>("/me/caravans/:caravanId/recruit", { preHandler: requireAuth }, async (req, reply) => {
    const body = bodyObject(req.body);
    const result = await recruitMercenary(app.db, {
      accountId: req.auth!.account.id,
      caravanId: req.params.caravanId,
      unitTypeId: body["unitTypeId"],
      requestId: body["requestId"],
      nowMs: Date.now(),
    });
    return reply.code(result.replayed ? 200 : 201).send({
      replayed: result.replayed,
      acquired: result.acquired,
      instance: result.instance,
      coinCost: result.coinCost,
      balanceAfter: result.balanceAfter,
      inventory: result.inventory,
      events: eventsOut(result.events),
    });
  });
}
