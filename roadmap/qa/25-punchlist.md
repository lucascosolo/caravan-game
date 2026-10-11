# Chunk 25 — QA punch list (commit 1e4203a, merged at ecbc300; migration 011)

Probes: scratchpad/qa25. Also re-checked chunk 14 items.

## Blocker
B1. `reassertSystemAccounts` matches `LIKE 'sys_outfit_%'` (`_` is a wildcard) while registration reserves the literal prefix: registering `sys_outfitx_evil` permanently breaks `db:seed` (and the content-drop hook). Use one shared literal-prefix predicate (`starts_with(username, $1)`) in registration and the seed; test with `sys_outfitx_evil` and `sys0outfit0evil`.

## Decisions (orchestrator)
D1. **Cold-start fairness:** keep 14-S4's preference for live parties, but at the widest pass fill authored parties nearest the centre first — seeded among the nearest N (`AUTHORED_FILL_NEAREST_N` = 6, tunable). A fresh player at 1000 must not routinely meet band-4 parties. Test: across 2000 seeds at centre 1000 on an empty pool, no candidate is more than one display band away.
D2. **Top-band variety:** the outside-band fallback draws seeded among the nearest `AUTHORED_FILL_NEAREST_N` too (not strictly nearest-first), so rerolls vary above ~2900. Also raise `AUTHORED_REPUTATION_CEILING` only if the test still shows < 3 distinct menus per 20 rerolls.
D3. **Authored rosters get a ledger story:** append `unit_acquired { source: "authored_set" }` per instance and a removal event on update; rebuild == live for rosters too.
D4. **Strip `snapshot.ownerAccountId` from the client view** (keep it in the stored row and job input); account ids are not public.

## Should-fix
S1. 011 down refuses while any `is_system` row exists (like 009); `migrate down N` / `reset` pre-check every guard before rolling anything back; AGENTS.md documents `DELETE FROM account WHERE is_system` before `db:reset`.
S2. Content drop validates cumulative cost per account (reached ∪ new nodes ≤ 30 per pool) for the whole set before any write, or applies the set in one transaction; refuse the whole drop on failure; test.
S3. Second-stage weight applies to the authored count actually eligible (`floor(min(authored, allowance) × weight)`); `weightedDown` true only when it changed the draw; thick-band test.
S4. Store the display band on encounter_candidates; index `(band, chosen_at DESC, trip_id, encounter_index DESC) WHERE chosen_at IS NOT NULL`; served-share query uses it.
S5. Pool scan: `UNION ALL` of the reputation-range branch and the system branch; store only parties within `band_width_used` plus the fallback filler (replay stays exact).
S6. Refuse system accounts in `issueSession` and `authenticate`, not just the login route; test.
S7. Rename "Chinook Raiders" (Chinook is an Indigenous nation); add a human-reviewed name list note in authoredOutfits.ts; extend the test word list.
S8. Chunk 19's "From chunk 14" block: skip ALL party-side progression (ladder, unlock points, Reputation, Coin) for `is_system` owners; the seed re-applies a spec when the live siege rating differs from the spec's.

## Nits
N1. When a chosen row exists, `enqueueEncounterResolution` requires that candidate's snapshot byte-for-byte.
N2. Store `weightedDown` and the basis points on the row so tunable changes don't alter replay.
N3. Candidate `displayName` for authored owners = outfit name (+ flavour available to chunk 24); no raw `sys_outfit_*` handles in the view.
N4. Doc drift: "migration 010" → 011 in PHASE-2.md:206 and qa/14-punchlist.md:10; merge PHASE-2 §25's two QA paragraphs.
N5. Bands 2/3 and 5/6 identical in max living tier and base merge level; differentiate.
N6. Deterministic ids in the retire-by-ratio test.
N7. Use `createAccountPoolProgress` instead of direct inserts (authored.ts:458).
