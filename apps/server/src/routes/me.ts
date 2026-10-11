import type { FastifyInstance } from "fastify";
import { toAccountPublic } from "../db/types.js";
import { listCaravansForAccount } from "../repo/caravans.js";
import { listPoolProgressForAccount } from "../repo/poolProgress.js";
import { listUnitInstancesForCaravan } from "../repo/unitInstances.js";
import { requireAuth } from "./require-auth.js";

/** The authorized player's own account, caravans (a list, always), progress and roster. */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", { preHandler: requireAuth }, async (req) => {
    const account = req.auth!.account;
    const caravans = await listCaravansForAccount(app.db, account.id);
    const progress = await listPoolProgressForAccount(app.db, account.id);
    const caravansWithUnits = await Promise.all(
      caravans.map(async (c) => ({ ...c, units: await listUnitInstancesForCaravan(app.db, c.id) })),
    );
    return {
      account: toAccountPublic(account),
      caravans: caravansWithUnits,
      poolProgress: progress,
    };
  });
}
