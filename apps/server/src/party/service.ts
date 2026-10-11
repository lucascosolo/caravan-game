/**
 * Standing raid party service (chunk 09): the server-side boundary where every party rule
 * is enforced — slot caps, the stance enum, approach edges and the entry band, duplicates,
 * roster membership and the unlock-web access gate. The pure rules live in @caravan/circle
 * (party.ts); this file applies them to an account's rows and maps failures to HTTP errors.
 *
 *   readParty    the owner's view: config, validity + every issue, the resolved party, the
 *                scouting preview EXACTLY as a defender will see it (same function, chunk
 *                14 calls it on the snapshot), the roster to build from, and the siege
 *                counter table — everything the builder needs to make an informed bet.
 *   saveParty    free, instant, no cooldown: validate, store the canonical config, append
 *                one `standing_party_saved` event. A no-op save appends nothing.
 *
 * THE GUARANTEE (GUARDRAILS §0, "Bounded stakes"): a party is a template that REFERENCES
 * roster instances by id. Nothing in this module — or anywhere on the resolution path —
 * writes unit_instance. A trip's attrition lands on the caravan's wagon_manifest and, in
 * chunk 19, on the roster through the caravan's own loss events; being served into a
 * fight never touches a party or its units. If an instance the party names stops existing
 * (lost on the owner's own trip, consumed by a merge), the party resolves as INVALID
 * (`unknown_ref`) at the next read or edit and the edit endpoint says so; it is never
 * silently trimmed, and the roster change is never blocked. A test greps this directory
 * for unit_instance writes.
 *
 * Scope (GUARDRAILS §5): the party is account-level; the units it references are
 * caravan-level and their living access is read on each unit's caravan; siege access is
 * read on the account.
 */
import { TUNABLES, SIEGE_TYPES, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
import {
  PARTY_EDIT_COOLDOWN_MS,
  PARTY_SLOT_CAP,
  ParseError,
  SIEGE_SLOT_CAP,
  MAX_APPROACH_EDGES,
  TARGETING_STANCES,
  manifestFromJson,
  partyConfigFromJson,
  partyEdges,
  resolveParty,
  scoutParty,
  serializePartyConfig,
  siegeCounterEntry,
  type Issue,
  type Party,
  type PartyConfig,
  type PartyScoutView,
  type RosterUnit,
  type ScoutSiege,
  type EntryEdge,
  type Validation,
} from "@caravan/circle";
import { createHash } from "node:crypto";
import type pg from "pg";
import { findOpenManifest } from "../circle/repo.js";
import type { Queryable } from "../db/pool.js";
import type { CaravanRow, StandingPartyRow } from "../db/types.js";
import type { JsonObject, LedgerEventDraft } from "../ledger/events.js";
import { appendEvents, lockAccountForAppend } from "../ledger/ledger.js";
import { listCaravansForAccount } from "../repo/caravans.js";
import { listUnitInstancesForCaravan } from "../repo/unitInstances.js";
import { AppError, badRequest } from "../services/errors.js";
import { accessCheckFor, unlockedTypeIds, type AccessPredicate } from "../unlocks/access.js";
import { PARTY_SLOT, findStandingParty, updateStandingPartyComposition, type PartyLock } from "./repo.js";

/** A 400 that carries the full issue list, so the builder can show every problem at once. */
export class PartyValidationError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly issues: readonly Issue[],
  ) {
    super(400, code, message);
    this.name = "PartyValidationError";
  }
}

export const notFound = (code: string, message: string) => new AppError(404, code, message);

export function partyHash(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** One living unit of the owner's roster as the builder sees it. */
export interface RosterEntryView {
  instanceId: string;
  caravanId: string;
  typeId: string;
  displayName: string;
  mergeLevel: number;
  /** Always 1 in a party: slot efficiency is the merge benefit. */
  slotCost: 1;
  /** The rating this unit fights with IN A PARTY. Unmerged type value. */
  offense: number;
  /** The rating it fights with when POSTED in a circle. Shown for comparison only. */
  defense: number;
  /** Max HP at this merge level. */
  hp: number;
  unlocked: boolean;
  inParty: boolean;
  /**
   * A unit may be both in the standing party and packed on a trip (the party is a template,
   * not a deployment). `packedOnTrip` says it is on the caravan's open manifest right now;
   * `aliveOnTrip` is its state there. Neither affects the party: it rides at full strength.
   */
  packedOnTrip: boolean;
  aliveOnTrip: boolean | null;
}

export interface PartyView {
  id: string;
  slot: number;
  createdAt: string;
  /** Last composition change; the version stamp a served snapshot records. */
  savedAt: string;
  /** sha256 of the canonical config. */
  hash: string;
  config: PartyConfig;
  valid: boolean;
  issues: readonly Issue[];
  /** The resolved party (what will be served), or null while invalid. */
  party: Party | null;
  /** The preview: byte-for-byte what a scouting defender is served. Null while invalid. */
  scout: PartyScoutView | null;
  edges: readonly EntryEdge[];
  caps: { units: number; siege: number; edges: number; editCooldownMs: number; partiesPerAccount: number };
  rules: {
    /** The party is a template: it is never consumed and never loses a unit, however many fights it is served into. */
    template: true;
    neverConsumed: true;
    /** The same instance may ride in the party and be packed on a trip at once. */
    unitsMayAlsoBePackedOnTrips: true;
    ratingInUse: "offense";
    stances: readonly string[];
  };
  roster: RosterEntryView[];
  /** Every siege type with its counter spelled out, and whether this account may field it. */
  siegeCatalog: (ScoutSiege & { unlocked: boolean })[];
}

interface RosterEntry extends RosterUnit {
  caravanId: string;
}

/** The owner's whole roster across their caravan(s), as party resolution sees it. */
export async function accountRoster(db: Queryable, accountId: string): Promise<{ caravans: CaravanRow[]; roster: RosterEntry[] }> {
  const caravans = await listCaravansForAccount(db, accountId);
  const roster: RosterEntry[] = [];
  for (const c of caravans) {
    for (const u of await listUnitInstancesForCaravan(db, c.id)) {
      roster.push({ instanceId: u.id, caravanId: c.id, typeId: u.unit_type_id, mergeLevel: u.merge_level });
    }
  }
  return { caravans, roster };
}

/**
 * The access predicate for a party: living types are unlocked on the caravan that owns the
 * instance (v1 has one caravan per account, so the union over caravans below is exact;
 * with several same-region caravans it would be an over-approximation to tighten then),
 * siege on the account (every caravan's owner triple reads the same account-level web).
 */
export async function partyAccessCheck(db: Queryable, accountId: string, caravans: readonly CaravanRow[]): Promise<AccessPredicate> {
  if (caravans.length === 0) {
    // No caravan: no living web at all; siege is still account-level but needs an owner
    // triple to read, so an account with no caravan can field nothing. Cannot happen after
    // onboarding; handled rather than assumed.
    void accountId;
    return () => false;
  }
  const preds: AccessPredicate[] = [];
  for (const c of caravans) preds.push(await accessCheckFor(db, { accountId: c.account_id, caravanId: c.id, regionId: c.region_id }));
  return (typeId) => preds.some((p) => p(typeId));
}

export interface ResolvedStandingParty {
  row: StandingPartyRow;
  config: PartyConfig;
  caravans: CaravanRow[];
  roster: RosterEntry[];
  access: AccessPredicate;
  result: Validation<Party>;
}

/**
 * Read the party row and resolve it against the live roster and web. Read-only. `lock`
 * is the row lock to take (QA N5): the snapshot path reads FOR SHARE so it cannot
 * interleave with an edit between reading the config and reading the roster.
 */
export async function resolveStandingParty(db: Queryable, accountId: string, opts: { lock?: PartyLock; slot?: number } = {}): Promise<ResolvedStandingParty | null> {
  const row = await findStandingParty(db, accountId, opts.slot ?? PARTY_SLOT, opts.lock ?? "none");
  if (!row) return null;
  const config = partyConfigFromJson(row.composition); // our own canonical write; a parse failure is a bug
  const { caravans, roster } = await accountRoster(db, accountId);
  const access = await partyAccessCheck(db, accountId, caravans);
  return { row, config, caravans, roster, access, result: resolveParty(config, roster, access) };
}

async function buildView(db: Queryable, r: ResolvedStandingParty): Promise<PartyView> {
  const canonical = serializePartyConfig(r.config);
  const inParty = new Set(r.config.units.map((u) => u.ref));
  // Which instances are packed on an open trip right now, and whether they still stand there.
  const onTrip = new Map<string, boolean>();
  for (const c of r.caravans) {
    const m = await findOpenManifest(db, c.id);
    if (!m) continue;
    for (const u of manifestFromJson(m.survivors).units) onTrip.set(u.ref, u.hp > 0);
  }
  const unlockedByCaravan = new Map<string, ReadonlySet<string>>();
  for (const c of r.caravans) unlockedByCaravan.set(c.id, await unlockedTypeIds(db, { accountId: c.account_id, caravanId: c.id, regionId: c.region_id }));
  const roster: RosterEntryView[] = r.roster.map((u) => {
    const type = getUnitType(u.typeId);
    return {
      instanceId: u.instanceId,
      caravanId: u.caravanId,
      typeId: u.typeId,
      displayName: type?.displayName ?? u.typeId,
      mergeLevel: u.mergeLevel,
      slotCost: 1,
      offense: type?.offense ?? 0,
      defense: type?.defense ?? 0,
      hp: type ? scaleInt(type.hp, mergeStatMult(u.mergeLevel)) : 0,
      unlocked: unlockedByCaravan.get(u.caravanId)?.has(u.typeId) ?? false,
      inParty: inParty.has(u.instanceId),
      packedOnTrip: onTrip.has(u.instanceId),
      aliveOnTrip: onTrip.get(u.instanceId) ?? null,
    };
  });
  const party = r.result.ok ? r.result.value : null;
  return {
    id: r.row.id,
    slot: r.row.slot,
    createdAt: r.row.created_at.toISOString(),
    savedAt: r.row.updated_at.toISOString(),
    hash: partyHash(canonical),
    config: r.config,
    valid: r.result.ok,
    issues: r.result.ok ? [] : r.result.issues,
    party,
    scout: party ? scoutParty(party) : null,
    edges: partyEdges(r.config),
    caps: { units: PARTY_SLOT_CAP, siege: SIEGE_SLOT_CAP, edges: MAX_APPROACH_EDGES, editCooldownMs: PARTY_EDIT_COOLDOWN_MS, partiesPerAccount: TUNABLES.PARTIES_PER_ACCOUNT },
    rules: { template: true, neverConsumed: true, unitsMayAlsoBePackedOnTrips: true, ratingInUse: "offense", stances: TARGETING_STANCES },
    roster,
    siegeCatalog: SIEGE_TYPES.map((s) => ({ ...siegeCounterEntry(s), unlocked: r.access(s.id) })),
  };
}

export async function readParty(db: Queryable, accountId: string): Promise<PartyView> {
  const r = await resolveStandingParty(db, accountId);
  if (!r) throw notFound("no_party", "this account has no standing party");
  return buildView(db, r);
}

/**
 * Save. Inside the caller's transaction: take the account append lock FIRST (QA S2 — a
 * merge or any other roster change on this account holds the same lock, so the roster
 * this save validates against cannot change under it), lock the party row, resolve the
 * submitted config against the live roster and web, refuse with every issue if it does
 * not stand, store the canonical form (the row's `save_seq` advances with it, QA S4),
 * append one `standing_party_saved`. Free, instant, no cooldown — PARTY_EDIT_COOLDOWN_MS
 * is 0 by design and nothing reads it as a gate; the per-account request limit on the
 * route is an abuse limit, not a gameplay cooldown. Idempotent: saving the stored
 * composition again changes nothing and appends nothing.
 */
export async function saveParty(client: pg.PoolClient, accountId: string, body: unknown): Promise<PartyView> {
  let config: PartyConfig;
  try {
    config = partyConfigFromJson(body);
  } catch (err) {
    if (err instanceof ParseError) throw badRequest("malformed_party", err.message);
    throw err;
  }
  await lockAccountForAppend(client, accountId);
  const current = await resolveStandingParty(client, accountId, { lock: "update" });
  if (!current) throw notFound("no_party", "this account has no standing party");
  const result = resolveParty(config, current.roster, current.access);
  if (!result.ok) throw new PartyValidationError("invalid_party", "the party cannot stand as configured", result.issues);
  const canonical = serializePartyConfig(config);
  if (canonical === serializePartyConfig(current.config)) return buildView(client, current);

  const row = await updateStandingPartyComposition(client, current.row.id, canonical);
  const saveSeq = row.save_seq;
  const hash = partyHash(canonical);
  await appendEvents(client, `party_saved:${row.id}:${saveSeq}`, [
    {
      type: "standing_party_saved",
      accountId,
      payload: {
        partyId: row.id,
        slot: row.slot,
        saveSeq,
        hash,
        units: result.value.units.length,
        siege: result.value.siege.length,
        edges: partyEdges(result.value),
        config: JSON.parse(canonical) as JsonObject,
      },
    },
  ]);
  return buildView(client, { ...current, row, config, result });
}

// ── QA S3: a roster change that removes an instance the party names ─────────────────────
//
// The party is never trimmed and the roster change is never blocked (chunk file, build
// notes); but the owner must not be surprised by an invalid party. So every path that
// removes an instance (chunk 16's merge now; chunk 19's trip loss later) does two things
// through the helpers below: it ASKS first, so an endpoint can refuse until the player
// confirms (merge: 409 `unit_in_party` unless `confirmInParty: true`), and it RECORDS an
// account-scoped `standing_party_invalidated` event under its own causation id when it
// goes ahead, carrying the issue list the party now resolves to. Both read under the
// caller's account append lock, which saveParty also takes before reading the roster.

export interface PartyMembership {
  partyId: string | null;
  /** The subset of the instance ids asked about that the standing party names, sorted. */
  inParty: string[];
}

/** Which of `instanceIds` the account's standing party names right now. Read-only. */
export async function partyMembership(db: Queryable, accountId: string, instanceIds: readonly string[]): Promise<PartyMembership> {
  const row = await findStandingParty(db, accountId, PARTY_SLOT, "none");
  if (!row) return { partyId: null, inParty: [] };
  const refs = new Set(partyConfigFromJson(row.composition).units.map((u) => u.ref));
  return { partyId: row.id, inParty: [...new Set(instanceIds.filter((id) => refs.has(id)))].sort() };
}

/**
 * After `removedRefs` have been removed from the roster (inside the remover's transaction,
 * after its DELETE): the draft of the `standing_party_invalidated` event to append under
 * the remover's causation id, or null when the party named none of them. The payload
 * carries the party's identity (id, slot, saveSeq, hash — the composition itself is NOT
 * changed), why, which refs went, and the full issue list the party resolves to now.
 */
export async function standingPartyInvalidationDraft(
  db: Queryable,
  accountId: string,
  removedRefs: readonly string[],
  reason: "merge" | "trip_loss",
): Promise<LedgerEventDraft | null> {
  const r = await resolveStandingParty(db, accountId, { lock: "share" });
  if (!r) return null;
  const named = new Set(r.config.units.map((u) => u.ref));
  const removed = [...new Set(removedRefs.filter((id) => named.has(id)))].sort();
  if (removed.length === 0) return null;
  const issues = r.result.ok ? [] : r.result.issues.map((i) => (i.subject === undefined ? { code: i.code, message: i.message } : { code: i.code, message: i.message, subject: i.subject }));
  return {
    type: "standing_party_invalidated",
    accountId,
    payload: {
      partyId: r.row.id,
      slot: r.row.slot,
      saveSeq: r.row.save_seq,
      hash: partyHash(serializePartyConfig(r.config)),
      reason,
      removedRefs: removed,
      valid: r.result.ok,
      issues,
    },
  };
}
