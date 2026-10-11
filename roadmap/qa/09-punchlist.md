# Chunk 09 — QA punch list (commit aa54ba6, merge f0a2209; migration is 008)

## Blocker
B1. The party a defender scouts is not guaranteed to be the party served: the only snapshot is taken at formation commit. **Assigned to chunk 14 (in progress), not the chunk 09 fixer:** snapshot once at candidate selection, scout from the stored snapshot, `enqueueEncounterResolution` accepts a pre-taken `partySnapshot` and never re-resolves, invalid parties are dropped at candidate generation. Chunk 09 fixer only documents the contract in the chunk 09 file.

## Decisions (orchestrator)
D1. Union-of-caravans access is acceptable for v1; tighten to `access(instance.caravanId)` when multi-caravan lands. Note in the chunk file and PHASE-2 §46.
D2. Usernames are public handles; the feed may show the defender's username and caravan name. Record.
S3 decision: append an account-scoped `standing_party_invalidated` ledger event (new enum value; migration in place) from both instance-removing paths (merge now; chunk 19 loss later, note in its chunk file) with the issue list; the merge endpoint refuses with 409 `unit_in_party` unless the request carries `confirmInParty: true`, and the preview reports `inParty` per instance.

## Should-fix
S1. Reflection amplifier: cap ref/siege id length in the strict parser (> 64 chars → `malformed_party`); never echo raw values in messages; `subject` truncated.
S2. `saveParty` reads the roster unlocked; take `lockAccountForAppend` before reading the roster so merges serialize with saves.
S3. → decision above.
S4. Per-account request rate limit on PUT /me/party (plain abuse limit, not a gameplay cooldown, never purchasable; tunable `PARTY_SAVE_RATE_LIMIT_PER_MINUTE` 30 in server infra tunables); store `saveSeq` as a counter column, not `count(*)`.

## Cross-chunk (also this fixer)
X1. `packages/circle/src/resolverInput.ts:107` scales a post's `defense` by `mergeStatMult`, contradicting chunk 03's B1 decision (ratings never scale; only HP and post-formula damage output). Remove the defense scaling; HP scaling stays; add a test pinning that offense/defense in the battlefield equal the unscaled type ratings at every merge level.
X2. Rename the chunk 02 ledger enum value `coin_transferred_to_defender` → `coin_transferred_to_party_owner` (GUARDRAILS §0 naming discipline; the receiver is the attacking party's owner). Edit migration 002 in place, events.ts, projection, tests.

## Nits
N1. Party parse errors say "malformed snapshot"; use a party-specific prefix.
N2. Use `TARGETING_STANCES` instead of the literal list in service.ts:230.
N3. Snapshot carries `partyId` and `hash`, and chunk 13's `party_served_as_encounter` payload must carry them (note in chunk 13 file).
N4. Drop the redundant `standing_party_account_idx`.
N5. Read the party row FOR SHARE in snapshot/resolve so concurrent snapshots during an edit cannot mix old config with new roster.
