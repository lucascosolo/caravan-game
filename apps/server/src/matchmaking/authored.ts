/**
 * Authored cold-start parties (chunk 14's seam for PHASE-2 §25). A pool that is never
 * empty: system accounts, flagged `is_system`, each owning an ORDINARY standing party —
 * the same rows, the same resolve, the same snapshot, the same scout view as any player's.
 * Matchmaking reads the flag only to cap the authored share of a band
 * (AUTHORED_PARTY_MAX_SHARE_BP); nothing downstream of selection can tell them apart, and
 * the resolver sees the same shape (a test compares the snapshots).
 *
 * This set is deliberately small — AUTHORED_PARTIES_PER_BAND per band for the lowest
 * AUTHORED_BANDS bands, enough that a fresh database serves three distinct, fully
 * scoutable candidates from the first search. Chunk 25 grows it to twelve per band across
 * the whole range, every siege piece and every roster; here only the free starting types
 * are used, because the unlock web is the only access gate and a system account has not
 * climbed it (GUARDRAILS §3 — authored content gets no bypass either).
 *
 * Coin lost to an authored party is destroyed, not banked (chunk 19 reads is_system for
 * that); Reputation shifts apply to the player only. The accounts cannot log in: their
 * password is a discarded random secret.
 */
import { REGION_IDS, TUNABLES, type RegionId } from "@caravan/content";
import { entryBand, type EntryEdge, type PartyConfig } from "@caravan/circle";
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { hashPassword } from "../auth/password.js";
import { withTransaction } from "../db/pool.js";
import { saveParty } from "../party/service.js";
import { createAccount, createHomeTown, createStandingParty, findAccountByUsername } from "../repo/accounts.js";
import { createAccountPoolProgress } from "../repo/poolProgress.js";
import { createUnitInstance } from "../repo/unitInstances.js";
import { createCaravanForAccount } from "../services/caravans.js";
import { bandCentre } from "./band.js";

export const AUTHORED_USERNAME_PREFIX = "sys_outfit_";
/** Lowest display bands that get authored parties (0 = the floor band; REPUTATION_START sits in band 3). */
export const AUTHORED_BANDS = 4;
export const AUTHORED_PARTIES_PER_BAND = 3;

/** The two free (tier-0) living types of each region's web — what a fresh caravan can field. */
const STARTING_TYPES: Readonly<Record<RegionId, readonly [string, string]>> = {
  desert: ["desert.dust_rider", "desert.well_digger"],
  high_plains: ["high_plains.homesteader", "high_plains.prairie_wolf"],
  mountain: ["mountain.grizzly", "mountain.trapper"],
  badlands: ["badlands.gunslinger", "badlands.bounty_hunter"],
};
const STARTING_SIEGE = "siege.battering_wagon";
const STANCES = ["nearest", "traps", "core"] as const;
const EDGES: readonly EntryEdge[] = ["north", "east", "south", "west"];

export interface AuthoredPartySpec {
  username: string;
  band: number;
  /** The owner's siege Reputation. */
  rating: number;
  regionId: RegionId;
  units: { typeId: string; mergeLevel: number }[];
  siege: string[];
  /** Stance per unit, cycling; edges per unit, split across `edgeCount` edges. */
  edgeCount: number;
}

/**
 * The authored set, derived deterministically from the band layout so a content drop can
 * regenerate it. Per band: three outfits of rising size and merge level, one per stance
 * emphasis, across the four regions in turn, splitting across 1, 2 or 4 edges.
 */
export function authoredPartySpecs(): AuthoredPartySpec[] {
  const specs: AuthoredPartySpec[] = [];
  let n = 0;
  for (let band = 0; band < AUTHORED_BANDS; band++) {
    for (let i = 0; i < AUTHORED_PARTIES_PER_BAND; i++) {
      const regionId = REGION_IDS[n % REGION_IDS.length]!;
      const [a, b] = STARTING_TYPES[regionId];
      const size = Math.min(TUNABLES.PARTY_SLOT_CAP, 3 + band + i); // 3..8
      const level = Math.min(TUNABLES.MERGE_LEVEL_MAX, 1 + Math.floor((band * AUTHORED_PARTIES_PER_BAND + i) / 3)); // 1..5 over the bands
      const units = [];
      for (let u = 0; u < size; u++) units.push({ typeId: u % 2 === 0 ? a : b, mergeLevel: u === 0 ? level : Math.max(1, level - (u % 2)) });
      specs.push({
        username: `${AUTHORED_USERNAME_PREFIX}${String(n + 1).padStart(2, "0")}`,
        band,
        rating: bandCentre(band) + (i - 1) * 100,
        regionId,
        units,
        siege: i === 0 ? [] : [STARTING_SIEGE],
        edgeCount: [1, 2, 4][i]!,
      });
      n++;
    }
  }
  return specs;
}

/** The PartyConfig for a spec over the instance ids just created (one per spec unit, in order). */
export function authoredPartyConfig(spec: AuthoredPartySpec, instanceIds: readonly string[]): PartyConfig {
  if (instanceIds.length !== spec.units.length) throw new RangeError("one instance id per unit");
  const edges = EDGES.slice(0, spec.edgeCount);
  return {
    v: 1,
    units: instanceIds.map((ref, i) => {
      const edge = edges[i % edges.length]!;
      const band = entryBand(edge);
      // Spread along the band: every other cell, wrapping, so no two units sit in the same cell.
      const cell = band[(i * 2 + spec.band) % band.length]!;
      return { ref, stance: STANCES[(i + spec.band) % STANCES.length]!, edge, cell };
    }),
    siege: [...spec.siege],
  };
}

export interface SeedAuthoredResult {
  created: string[];
  existing: string[];
}

/**
 * Create every authored party that does not exist yet. Idempotent by username; each party
 * is created in its own transaction. Runs as the app role (the seed script's connection):
 * it inserts the siege progress row at the authored rating, which is an ordinary INSERT.
 */
export async function seedAuthoredParties(pool: pg.Pool): Promise<SeedAuthoredResult> {
  const out: SeedAuthoredResult = { created: [], existing: [] };
  for (const spec of authoredPartySpecs()) {
    if (await findAccountByUsername(pool, spec.username)) {
      out.existing.push(spec.username);
      continue;
    }
    const passwordHash = await hashPassword(randomBytes(32).toString("base64"));
    await withTransaction(pool, async (client) => {
      const account = await createAccount(client, { username: spec.username, passwordHash });
      await client.query("UPDATE account SET is_system = true WHERE id = $1", [account.id]);
      await createHomeTown(client, account.id);
      await createStandingParty(client, account.id);
      await createAccountPoolProgress(client, account.id, "trap");
      await client.query("INSERT INTO pool_progress (pool, account_id, reputation) VALUES ('siege', $1, $2)", [account.id, spec.rating]);
      const caravan = await createCaravanForAccount(client, { accountId: account.id, regionId: spec.regionId, name: `Outfit ${spec.username.slice(AUTHORED_USERNAME_PREFIX.length)}` });
      const ids: string[] = [];
      for (const u of spec.units) ids.push((await createUnitInstance(client, { caravanId: caravan.id, unitTypeId: u.typeId, mergeLevel: u.mergeLevel })).id);
      const view = await saveParty(client, account.id, authoredPartyConfig(spec, ids));
      if (!view.valid) throw new Error(`authored party ${spec.username} does not resolve: ${view.issues.map((i) => i.message).join("; ")}`);
    });
    out.created.push(spec.username);
  }
  return out;
}
