/**
 * Dev seed: one playable-shaped account for later chunks to develop against.
 *   username: dev   password: devpassword   region: desert
 * Idempotent: if `dev` already exists, nothing is changed.
 *
 *   pnpm db:seed
 */
import { REGIONS, isUnitTypeId } from "@caravan/content";
import { createPool } from "./db/pool.js";
import { seedAuthoredParties } from "./matchmaking/authored.js";
import { findAccountByUsername } from "./repo/accounts.js";
import { listCaravansForAccount } from "./repo/caravans.js";
import { createUnitInstance } from "./repo/unitInstances.js";
import { registerAccount } from "./services/onboarding.js";

/**
 * Chunk 08: SEED_USERNAME / SEED_PASSWORD may be overridden from the environment so the
 * formation e2e can seed a run-unique account with the same roster (its trip state — a
 * locked manifest, a committed formation — is never reset, so a fresh account per run is
 * the only way to start from "in town"). Defaults are the dev account.
 */
export const SEED_USERNAME = process.env["SEED_USERNAME"] ?? "dev";
export const SEED_PASSWORD = process.env["SEED_PASSWORD"] ?? "devpassword";
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
    // Chunk 14: the authored cold-start parties (PHASE-2 §25), so a fresh database serves
    // three scoutable candidates from the first search. Idempotent.
    const authored = await seedAuthoredParties(pool);
    console.log(`Authored parties: ${authored.created.length} created, ${authored.existing.length} already present.`);
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
