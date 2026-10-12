/**
 * The seed (final review S1).
 *
 *   pnpm db:seed           the authored cold-start parties only (PHASE-2 §25): what every
 *                          database — dev, test, the play test — needs for matchmaking to serve
 *                          three scoutable candidates at every band. Idempotent and versioned.
 *   pnpm db:seed -- --dev  ALSO the dev / e2e fixture account (username dev, password
 *                          devpassword, region desert; SEED_USERNAME / SEED_PASSWORD override it).
 *                          REFUSED when NODE_ENV=production.
 *
 * Both write through the ordinary services as the app role (DATABASE_URL): the authored parties
 * reach their nodes by ladder rungs and appear in the ledger (chunk 25 QA D3); the dev account is
 * an ordinary registration whose only units are the STARTING_ROSTER granted through `grantUnit`.
 */
import { REGIONS } from "@caravan/content";
import { assertProductionDatabaseUrl, loadDotEnv } from "./config.js";
import { createPool } from "./db/pool.js";
import { DevSeedRefusedError, devSeedRequested, seedDevAccount } from "./dev/devAccount.js";
import { seedAuthoredParties } from "./matchmaking/authored.js";

loadDotEnv();

export const SEED_USERNAME = process.env["SEED_USERNAME"] ?? "dev";
export const SEED_PASSWORD = process.env["SEED_PASSWORD"] ?? "devpassword";
export const SEED_REGION = REGIONS[0].id;

async function main(): Promise<void> {
  let dev: boolean;
  try {
    dev = devSeedRequested(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof DevSeedRefusedError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  assertProductionDatabaseUrl(process.env, process.env["DATABASE_URL"], "DATABASE_URL");
  const pool = createPool();
  try {
    const authored = await seedAuthoredParties(pool);
    console.log(`Authored parties (set v${authored.version}): ${authored.created.length} created, ${authored.updated.length} updated, ${authored.existing.length} already current.`);
    if (!dev) {
      console.log("No login accounts were created (pass --dev for the dev / e2e fixture account; refused in production).");
      return;
    }
    const r = await seedDevAccount(pool, { username: SEED_USERNAME, password: SEED_PASSWORD, regionId: SEED_REGION });
    console.log(
      r.created
        ? `Seeded dev account '${SEED_USERNAME}' (${r.accountId}), caravan ${r.caravanIds[0]}, region '${SEED_REGION}', the starting roster only.`
        : `Dev account '${SEED_USERNAME}' already exists (account ${r.accountId}, ${r.caravanIds.length} caravan(s)). Nothing to do.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
