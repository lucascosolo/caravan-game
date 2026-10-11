# Chunk 07 — QA punch list (commits 470b86a, a9a49a9)

No blockers.

## Decisions (orchestrator)
D1 (S9a). **Posted units carry a defensive stance.** PROJECT.md §9 says "where units are posted and with what stance"; this is not optional. Formation becomes `v: 2` with `stance: "guard" | "hold" | "reserve"` per post (default `guard`). Semantics for chunk 11: `guard` = the brief's aggro/leash pursuit; `hold` = fights only attackers within attack range of its post, never leaves it (leash 0); `reserve` = ignores everything until an attacker is inside the ring (any lattice cell with Chebyshev distance < 4 from the core centre), then behaves as `guard`. `reserve` is the "kept safely in the back" choice §13.4 describes, so the rule "every living unit must be posted" stands (S9b accepted as-is). Record in PROJECT.md's revision note (one line) and in the chunk 11 file.
D2 (S5). **Ring corners are fixed wagon anchors.** The four corner cells are permanent impassable anchors shown as parked wagons, not buyable fence. `PERIMETER_SEGMENTS` = 28, `FENCE_MATERIAL_BUDGET` = 20 (still forces 8 gaps). Pathing is 4-connected with no corner cutting (`PATH_CONNECTIVITY` = 4), decided for chunk 10 in parallel. The Battlefield input carries the anchors as blocked cells. Test: all 28 fenced → core unreachable; any single non-corner gap → reachable.

## Should-fix
S1. resolverInput.ts: close `ability`/`effect` key sets; validate `edge ∈ ENTRY_EDGES`, categories/affinities against content enums, `pos` within `[0, GRID×SCALE)`; refuse unknown keys at every level. Test each.
S2. `applyOutcome` accepts attrition on refs not placed in the committed formation; load it and refuse spentTraps / fence hp changes for unplaced refs.
S3. Pack body parsing lenient: reject arrays and unknown keys like `formationFromJson`; **decision:** a manifest must pack ≥ 1 living unit (`manifest_empty` 400) — bounded stakes are vacuous otherwise.
S4. Route id regex admits non-UUIDs → 500. Real UUID regex, 404 otherwise.
S5. → D2.
S6. Survivors trigger: assert each hp is a non-negative integer ≤ maxHp, refs distinct, `v`/top-level keys unchanged, per-entry key sets unchanged.
S7. `battlefieldForEncounter` for a resolved encounter returns post-outcome HP. Store the survivors snapshot alongside each committed formation (so a replay input is byte-reproducible) and build from it; refuse index ≤ encounters_resolved only if no snapshot exists.
S8. Refuse oversized formations before validation (fences > PERIMETER_SEGMENTS, traps > TRAP_SLOT_CAP, posts > DEPLOYMENT_SLOT_CAP) and cap the issue list at 50.
S9. → D1.

## Nits
N1. Add `bad_version` issue code.
N2. Encounter index regex `^[1-9]\d{0,5}$`.
N3. Prefix unit refs (`u:<id>`) or assert namespace disjointness in `packManifest`.
N4. Validate outcome shape in `applyAttritionOutcome` → `AttritionError`.
N5. Trigger: `encounters_resolved` may only advance by 1; formation rows only insertable with `committed_at IS NULL`.
N6. Comment that fractional MIN_POST_DISTANCE is a no-op.
N7. `unit_instance` has no "on a trip" mark. Closed by chunk 16's fix S1 (merge refuses on `caravan.state = on_trip`); chunk 15 must set state before locking the manifest — note in chunk 15 file.
