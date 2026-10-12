/**
 * The dev / e2e fixture account (final review S1). Created ONLY by `seed.ts --dev`, which is
 * refused under NODE_ENV=production.
 *
 * It is an ordinary registration: `registerAccount` creates the hub rows and the caravan, and
 * the caravan gets the STARTING_ROSTER through `grantUnit` like every caravan (the access check
 * runs, one `unit_acquired` event per instance). Nothing is inserted around the ledger and no
 * type outside the region's starting web is granted, so the ledger rebuild of this account
 * equals its live state (final review N5). The first-session guide is marked done, because the
 * fixture is used by specs that start past onboarding.
 */
import type pg from "pg";
import type { RegionId } from "@caravan/content";
import { markOnboardingDone } from "../onboarding/service.js";
import { findAccountByUsername } from "../repo/accounts.js";
import { listCaravansForAccount } from "../repo/caravans.js";
import { registerAccount } from "../services/onboarding.js";

export interface DevAccountInput {
  username: string;
  password: string;
  regionId: RegionId;
}

export interface DevAccountResult {
  created: boolean;
  accountId: string;
  caravanIds: string[];
}

/** Idempotent: an existing account of that username is left exactly as it is. */
export async function seedDevAccount(pool: pg.Pool, input: DevAccountInput): Promise<DevAccountResult> {
  const existing = await findAccountByUsername(pool, input.username);
  if (existing) {
    const caravans = await listCaravansForAccount(pool, existing.id);
    return { created: false, accountId: existing.id, caravanIds: caravans.map((c) => c.id) };
  }
  const { account, caravan } = await registerAccount(pool, {
    username: input.username,
    password: input.password,
    regionId: input.regionId,
    caravanName: "Dev Caravan",
  });
  await markOnboardingDone(pool, account.id);
  return { created: true, accountId: account.id, caravanIds: [caravan.id] };
}

/** Thrown when `--dev` is asked for under NODE_ENV=production. */
export class DevSeedRefusedError extends Error {
  constructor() {
    super("seed --dev is refused when NODE_ENV=production: the dev account has a published password");
    this.name = "DevSeedRefusedError";
  }
}

/** The argv / env decision, pure so it can be tested. */
export function devSeedRequested(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  const dev = argv.includes("--dev");
  if (dev && env["NODE_ENV"] === "production") throw new DevSeedRefusedError();
  return dev;
}
