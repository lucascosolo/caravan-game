/**
 * Account-level exclusions for matchmaking (chunk 14).
 *
 * SELF_EXCLUDE is unconditional: the caravan's own account is always excluded in
 * searchCandidates. This file is the SEAM for PHASE-2 §31 (alt-feeding): accounts that a
 * soft-link score ties to the defender's are excluded exactly like self. v1 links nothing
 * — the resolver below returns no accounts — and chunk 31 replaces it with device, payment
 * instrument and network heuristics. Exclude and flag, never ban on the heuristic alone.
 * Nothing here may read purchase state (§31 QA check).
 */
import type { Queryable } from "../db/pool.js";

export type LinkedAccountsResolver = (db: Queryable, accountId: string) => Promise<readonly string[]>;

/** v1: no linked accounts. */
export const noLinkedAccounts: LinkedAccountsResolver = async () => [];
