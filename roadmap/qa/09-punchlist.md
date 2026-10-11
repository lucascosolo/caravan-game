# Chunk 09 — QA punch list (commit aa54ba6, merge f0a2209; migration is 008)

Closure (2026-10-11): everything below except B1 is `[closed]` on the chunk 09 fixer branch;
details and the B1 contract are under "QA round 1" in `roadmap/chunks/09-standing-raid-party.md`.

## Blocker
B1. [open — chunk 14] The party a defender scouts is not guaranteed to be the party served: the only snapshot is taken at formation commit. **Assigned to chunk 14 (in progress), not the chunk 09 fixer:** snapshot once at candidate selection, scout from the stored snapshot, `enqueueEncounterResolution` accepts a pre-taken `partySnapshot` and never re-resolves, invalid parties are dropped at candidate generation. Chunk 09 fixer only documents the contract in the chunk 09 file. → Contract written (chunk 09 file, "B1"); `enqueueEncounterResolution` and the snapshot call site untouched.

## Decisions (orchestrator)
D1. [closed] Union-of-caravans access is acceptable for v1; tighten to `access(instance.caravanId)` when multi-caravan lands. Note in the chunk file and PHASE-2 §46. → Both notes written.
D2. [closed] Usernames are public handles; the feed may show the defender's username and caravan name. Record. → Recorded in the chunk file; no code change.
S3 decision: [closed] append an account-scoped `standing_party_invalidated` ledger event (new enum value; migration in place) from both instance-removing paths (merge now; chunk 19 loss later, note in its chunk file) with the issue list; the merge endpoint refuses with 409 `unit_in_party` unless the request carries `confirmInParty: true`, and the preview reports `inParty` per instance. → Enum value in migration 002 + `events.ts`; `partyMembership` / `standingPartyInvalidationDraft` in `party/service.ts`; merge preview `consumed.inParty` + `requiresConfirmInParty`; commit 409 `unit_in_party` (body lists `inParty`) unless `confirmInParty: true`; event appended alongside `unit_merged` under the merge causation; chunk 19 file notes the `trip_loss` call.

## Should-fix
S1. [closed] Reflection amplifier: cap ref/siege id length in the strict parser (> 64 chars → `malformed_party`); never echo raw values in messages; `subject` truncated. → `MAX_ID_LENGTH` 64 in `party.ts`; parser refuses by position; `resolveParty`/`assertParty` messages name entries by position, `issueSubject` truncates.
S2. [closed] `saveParty` reads the roster unlocked; take `lockAccountForAppend` before reading the roster so merges serialize with saves. → Lock taken first; six-round race test.
S3. [closed] → decision above.
S4. [closed] Per-account request rate limit on PUT /me/party (plain abuse limit, not a gameplay cooldown, never purchasable; tunable `PARTY_SAVE_RATE_LIMIT_PER_MINUTE` 30 in server infra tunables); store `saveSeq` as a counter column, not `count(*)`. → `src/util/rateLimit.ts` sliding window, 429 `rate_limited` + `retry-after`; `standing_party.save_seq` column with trigger-enforced +1 per composition change (migration 008 in place).

## Cross-chunk (also this fixer)
X1. [closed] `packages/circle/src/resolverInput.ts:107` scales a post's `defense` by `mergeStatMult`, contradicting chunk 03's B1 decision (ratings never scale; only HP and post-formula damage output). Remove the defense scaling; HP scaling stays; add a test pinning that offense/defense in the battlefield equal the unscaled type ratings at every merge level. → Removed; test over levels 1–5 in `battlefield.test.ts`. (The `BattlefieldPost.defense` doc comment in `packages/resolver` still says "scaled" — chunk 10's file, flagged.)
X2. [closed] Rename the chunk 02 ledger enum value `coin_transferred_to_defender` → `coin_transferred_to_party_owner` (GUARDRAILS §0 naming discipline; the receiver is the attacking party's owner). Edit migration 002 in place, events.ts, projection, tests. → Done (projection folds through `COIN_CREDIT_TYPES`, so no literal there); a test pins the code list equal to the DB enum. Stale mentions remain in `chunks/02-*.md` and historical ORCHESTRATION entries (not this fixer's files).

## Nits
N1. [closed] Party parse errors say "malformed snapshot"; use a party-specific prefix. → `ParseError(message, kind)`; party parsers say `malformed party: …`.
N2. [closed] Use `TARGETING_STANCES` instead of the literal list in service.ts:230.
N3. [closed] Snapshot carries `partyId` and `hash`, and chunk 13's `party_served_as_encounter` payload must carry them (note in chunk 13 file). → Already carried; chunk 13 file requires `partyId`, `partyHash`, `partySavedAt`.
N4. [closed] Drop the redundant `standing_party_account_idx`. → Dropped from migration 008 up/down; test asserts absence.
N5. [closed] Read the party row FOR SHARE in snapshot/resolve so concurrent snapshots during an edit cannot mix old config with new roster. → `findStandingParty(db, account, slot, "none" | "share" | "update")`; snapshot reads FOR SHARE.
