/**
 * Dev seed: one playable-shaped account for later chunks to develop against.
 *   username: dev   password: devpassword   region: desert
 * Idempotent: if `dev` already exists, nothing is changed.
 *
 *   pnpm db:seed
 */
import { REGIONS, isUnitTypeId } from "@caravan/content";
import { createPool } from "./db/pool.js";
import { findAccountByUsername } from "./repo/accounts.js";
import { listCaravansForAccount } from "./repo/caravans.js";
import { createUnitInstance } from "./repo/unitInstances.js";
import { registerAccount } from "./services/onboarding.js";

export const SEED_USERNAME = "dev";
export const SEED_PASSWORD = "devpassword";
export const SEED_REGION = REGIONS[0].id;

// Real unit type ids from @caravan/content (chunk 03). Desert roster: two scouts-equivalent
// riders to merge, a ranged unit, and a healer — enough shape to render and merge against.
const SEED_UNIT_TYPES = [
  { unitTypeId: "desert.dust_rider", mergeLevel: 1 },
  { unitTypeId: "desert.dust_rider", mergeLevel: 1 },
  { unitTypeId: "desert.sand_sharpshooter", mergeLevel: 2 },
  { unitTypeId: "desert.canteen_carrier", mergeLevel: 1 },
] as const;
for (const u of SEED_UNIT_TYPES) {
  if (!isUnitTypeId(u.unitTypeId)) throw new Error(`seed references unknown unit type '${u.unitTypeId}'`);
}

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
    for (const u of SEED_UNIT_TYPES) {
      await createUnitInstance(pool, { caravanId: caravan.id, ...u });
    }
    console.log(`Seeded account '${SEED_USERNAME}' (${account.id}) with caravan '${caravan.name}' (${caravan.id}) in region '${caravan.region_id}' and ${SEED_UNIT_TYPES.length} units.`);
    console.log(`Log in with: POST /auth/login {"username":"${SEED_USERNAME}","password":"${SEED_PASSWORD}"}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
