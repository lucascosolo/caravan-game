/**
 * Caravan creation. The schema supports N caravans per account; v1 app logic enforces
 * TUNABLES.MAX_CARAVANS_PER_ACCOUNT here, at the service boundary, and nowhere else.
 */
import { TUNABLES, isRegionId } from "@caravan/content";
import type pg from "pg";
import type { CaravanRow } from "../db/types.js";
import { countCaravansForAccount, insertCaravan } from "../repo/caravans.js";
import { createCaravanPoolProgress } from "../repo/poolProgress.js";
import { grantStartingRoster } from "../acquisition/startingRoster.js";
import { badRequest, conflict } from "./errors.js";

export async function createCaravanForAccount(
  client: pg.PoolClient,
  input: { accountId: string; regionId: string; name?: string },
): Promise<CaravanRow> {
  if (!isRegionId(input.regionId)) {
    throw badRequest("invalid_region", `unknown region '${input.regionId}'`);
  }
  // Serialize per account so two concurrent requests can't both pass the count check.
  const acct = await client.query<{ is_system: boolean }>("SELECT is_system FROM account WHERE id = $1 FOR UPDATE", [input.accountId]);
  const existing = await countCaravansForAccount(client, input.accountId);
  if (existing >= TUNABLES.MAX_CARAVANS_PER_ACCOUNT) {
    throw conflict(
      "caravan_limit",
      `account already has ${existing} caravan(s); v1 allows ${TUNABLES.MAX_CARAVANS_PER_ACCOUNT}`,
    );
  }
  const caravan = await insertCaravan(client, {
    accountId: input.accountId,
    regionId: input.regionId,
    name: input.name ?? "Caravan",
  });
  // Caravan-level progress: the living-unit pool lives with the caravan, never the account.
  await createCaravanPoolProgress(client, caravan.id);
  // Chunk 24 QA D1: every player caravan starts with TUNABLES.STARTING_ROSTER, granted here
  // (the one creation path: registration, a guest account, a future second caravan) through
  // the ordinary ledgered acquisition grant — never in a route. A system (authored) caravan's
  // roster is its authored spec instead (chunk 25): it never rides a trip, and its units are content.
  if (acct.rows[0]?.is_system !== true) {
    await grantStartingRoster(client, { accountId: input.accountId, caravanId: caravan.id, regionId: input.regionId });
  }
  return caravan;
}
