/**
 * Cosmetic routes (PHASE-2 §28, chunk 20): what the account owns, what is equipped per
 * slot, and the catalog with each cosmetic's next offer week. Equipping is a drawing
 * preference; nothing here touches a caravan, a formation, a party or a job.
 */
import type { FastifyInstance } from "fastify";
import { equipCosmetic, listCosmetics, unequipSlot } from "../store/index.js";
import { requireAuth } from "./require-auth.js";

export async function cosmeticRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/cosmetics", { preHandler: requireAuth }, async (req) => listCosmetics(app.db, req.auth!.account.id, Date.now()));

  app.post<{ Body: { cosmeticId?: unknown } }>("/me/cosmetics/equip", { preHandler: requireAuth }, async (req) => {
    const body = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    return equipCosmetic(app.db, req.auth!.account.id, body.cosmeticId);
  });

  app.post<{ Body: { slot?: unknown } }>("/me/cosmetics/unequip", { preHandler: requireAuth }, async (req) => {
    const body = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    return unequipSlot(app.db, req.auth!.account.id, body.slot);
  });
}
