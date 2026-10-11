# Chunk 07 — QA punch list (commits 470b86a, a9a49a9)

No blockers.

## Decisions (orchestrator)
D1 (S9a). **[closed]** **Posted units carry a defensive stance.** PROJECT.md §9 says "where units are posted and with what stance"; this is not optional. Formation becomes `v: 2` with `stance: "guard" | "hold" | "reserve"` per post (default `guard`). Semantics for chunk 11: `guard` = the brief's aggro/leash pursuit; `hold` = fights only attackers within attack range of its post, never leaves it (leash 0); `reserve` = ignores everything until an attacker is inside the ring (any lattice cell with Chebyshev distance < 4 from the core centre), then behaves as `guard`. (Clarified by chunk 11 QA D1: "ignores" means it does not acquire or move — like every stance it still fires at an attacker in its reach.) `reserve` is the "kept safely in the back" choice §13.4 describes, so the rule "every living unit must be posted" stands (S9b accepted as-is). Record in PROJECT.md's revision note (one line) and in the chunk 11 file.
D2 (S5). **[closed]** **Ring corners are fixed wagon anchors.** The four corner cells are permanent impassable anchors shown as parked wagons, not buyable fence. `PERIMETER_SEGMENTS` = 28, `FENCE_MATERIAL_BUDGET` = 20 (still forces 8 gaps). Pathing is 4-connected with no corner cutting (`PATH_CONNECTIVITY` = 4), decided for chunk 10 in parallel. The Battlefield input carries the anchors as blocked cells. Test: all 28 fenced → core unreachable; any single non-corner gap → reachable.

## Should-fix
S1. **[closed]** resolverInput.ts: close `ability`/`effect` key sets; validate `edge ∈ ENTRY_EDGES`, categories/affinities against content enums, `pos` within `[0, GRID×SCALE)`; refuse unknown keys at every level. Test each.
S2. **[closed]** `applyOutcome` accepts attrition on refs not placed in the committed formation; load it and refuse spentTraps / fence hp changes for unplaced refs.
S3. **[closed]** Pack body parsing lenient: reject arrays and unknown keys like `formationFromJson`; **decision:** a manifest must pack ≥ 1 living unit (`manifest_empty` 400) — bounded stakes are vacuous otherwise.
S4. **[closed]** Route id regex admits non-UUIDs → 500. Real UUID regex, 404 otherwise.
S5. **[closed]** → D2.
S6. **[closed]** Survivors trigger: assert each hp is a non-negative integer ≤ maxHp, refs distinct, `v`/top-level keys unchanged, per-entry key sets unchanged.
S7. **[closed]** `battlefieldForEncounter` for a resolved encounter returns post-outcome HP. Store the survivors snapshot alongside each committed formation (so a replay input is byte-reproducible) and build from it; refuse index ≤ encounters_resolved only if no snapshot exists.
S8. **[closed]** Refuse oversized formations before validation (fences > PERIMETER_SEGMENTS, traps > TRAP_SLOT_CAP, posts > DEPLOYMENT_SLOT_CAP) and cap the issue list at 50.
S9. **[closed]** → D1.

## Nits
N1. **[closed]** Add `bad_version` issue code.
N2. **[closed]** Encounter index regex `^[1-9]\d{0,5}$`.
N3. **[closed]** Prefix unit refs (`u:<id>`) or assert namespace disjointness in `packManifest`.
N4. **[closed]** Validate outcome shape in `applyAttritionOutcome` → `AttritionError`.
N5. **[closed]** Trigger: `encounters_resolved` may only advance by 1; formation rows only insertable with `committed_at IS NULL`.
N6. **[closed]** Comment that fractional MIN_POST_DISTANCE is a no-op.
N7. **[closed]** `unit_instance` has no "on a trip" mark. Closed by chunk 16's fix S1 (merge refuses on `caravan.state = on_trip`); chunk 15 must set state before locking the manifest — note in chunk 15 file.

## Closure (Maker, 2026-10-11)

All items closed in one commit on the chunk 07 fix worktree. Where it landed:

- D1 — `packages/circle/src/formation.ts` (`DEFENSIVE_STANCES`, `v: 2`, `bad_stance`),
  `serialize.ts` (stance optional on input → `guard`; always in the canonical form),
  `resolverInput.ts` (`BattlefieldPost.stance`). PROJECT.md revision note, chunk 11 file.
- D2 — `packages/content/src/tunables.ts` (`PERIMETER_SEGMENTS` 28, `FENCE_MATERIAL_BUDGET`
  20, new `RING_ANCHOR_CELLS` 4, `PATH_CONNECTIVITY` 4), `lattice.ts` (`RING_ANCHORS`,
  `isAnchorCell`, `isRingOrAnchorCell`, `neighbours4`, anchors always blocked in
  `isCoreReachableFrom`, import-time coherence check), `resolverInput.ts`
  (`Battlefield.anchors`, `pathConnectivity`, `BATTLEFIELD_VERSION` 2). Test: all 28
  fenced seals; any single gap opens from every edge (`lattice.test.ts`).
- S1 — `resolverInput.ts` `assertBattlefield`: per-archetype ability key sets, per-kind
  effect key sets, `edge`/`category`/`affinity`/`stance` against the content enums, `pos`
  within `[0, GRID×SCALE)`, hp within `0..maxHp`, grid/anchors/entries pinned.
- S2 — `apps/server/src/circle/service.ts` `applyOutcome` loads the committed formation
  and refuses any unit/trap/fence ref not posted/laid/placed (`AttritionError`).
- S3 — `routes/circle.ts` `parsePackRequest` (no arrays, no unknown keys at either level);
  `manifest.ts` `manifest_empty` issue → 400 `manifest_empty` from the service.
- S4 — real UUID regex in `ownCaravan`. N2 — `^[1-9]\d{0,5}$`.
- S6 — migration 004 survivors trigger: top-level keys frozen, per-entry key sets frozen,
  hp a non-negative integer ≤ maxHp, `spent` boolean, refs distinct, entries objects.
- S7 — migration 004 `wagon_formation.survivors_snapshot` (NULL iff draft; at commit must
  equal the manifest's current `survivors`, encounter must be `encounters_resolved + 1`
  of an open manifest; frozen with the row). `commitFormation` writes it;
  `battlefieldForEncounter` builds from it and refuses a resolved encounter without one.
- S8 — `formationFromJson` and `validateFormation` refuse oversized lists before any
  per-entry work (`oversized`); `MAX_ISSUES` = 50 (`capIssues`).
- N1 `bad_version`; N3 ref-namespace disjointness asserted in `packManifest`
  (`duplicate_ref`); N4 `assertEncounterOutcome`; N5 counter +1 only, formation rows
  insert as drafts only (insert trigger); N6 comment on `MIN_POST_DIST_SQ_CELLS`; N7 note
  in chunk 15 file.
- Regressions: `packages/circle/test/*` (64 tests) and
  `apps/server/test/qa07-regressions.test.ts` (14 tests) reproduce every probe.
