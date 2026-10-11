/**
 * Dev seed: one playable-shaped account for later chunks to develop against.
 *   username: dev   password: devpassword   region: desert
 * Idempotent: if `dev` already exists, nothing is changed.
 *
 *   pnpm db:seed
 */
import { REGIONS } from "@caravan/content";
import { createPool } from "./db/pool.js";
import { findAccountByUsername } from "./repo/accounts.js";
import { listCaravansForAccount } from "./repo/caravans.js";
import { createUnitInstance } from "./repo/unitInstances.js";
import { registerAccount } from "./services/onboarding.js";

export const SEED_USERNAME = "dev";
export const SEED_PASSWORD = "devpassword";
export const SEED_REGION = REGIONS[0].id;

// Unit types come from @caravan/content in chunk 03. Until then the seed uses clearly
// marked placeholder ids so the roster has a shape to render and merge against.
const PLACEHOLDER_UNIT_TYPES = [
  { unitTypeId: `placeholder.${SEED_REGION}.scout`, mergeLevel: 1 },
  { unitTypeId: `placeholder.${SEED_REGION}.scout`, mergeLevel: 1 },
  { unitTypeId: `placeholder.${SEED_REGION}.rifleman`, mergeLevel: 2 },
  { unitTypeId: `placeholder.${SEED_REGION}.medic`, mergeLevel: 1 },
];

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const existing = await findAccountByUsername(pool, SEED_USERNAME);
    if (existing) {
      const caravans = await listCaravansForAccount(pool, existing.id);
      console.log(`Seed account '${SEED_USERNAME}' already exists (account ${existing.id}, ${caravans.length} caravan(s)). Nothing to do.`);
      return;
    }
    const { account, caravan } = await registerAccount(pool, {
      username: SEED_USERNAME,
      password: SEED_PASSWORD,
      regionId: SEED_REGION,
      caravanName: "Dev Caravan",
    });
    for (const u of PLACEHOLDER_UNIT_TYPES) {
      await createUnitInstance(pool, { caravanId: caravan.id, ...u });
    }
    console.log(`Seeded account '${SEED_USERNAME}' (${account.id}) with caravan '${caravan.name}' (${caravan.id}) in region '${caravan.region_id}' and ${PLACEHOLDER_UNIT_TYPES.length} placeholder units.`);
    console.log(`Log in with: POST /auth/login {"username":"${SEED_USERNAME}","password":"${SEED_PASSWORD}"}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
