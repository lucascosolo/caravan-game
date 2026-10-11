# Chunk 09 — Standing raid party

**Depends on:** 03, 05, 07. **Status:** built (server model, routes, feed, tests — 2026-10-11; the builder UI's visual parts are chunk 17's town screen and are listed below as deferred).
Read `/roadmap/GUARDRAILS.md` in full first, including §0 on which way round the game runs.

## Goal

The passive, asynchronous side of the game: a raiding party the player configures in
town, leaves standing, and which is served as an encounter in **other players' trips**.
Plus the results feed where its owner sees where it struck and how it did.

## Orientation

**This is the analog of a base in a base-raider** — a standing artifact other people
run into while you are not there. Its owner is never present for the fights it appears
in. The player's *active* game is defending their caravan (chunks 07–08); this is the
thing they tune between sessions and then check on.

**Critically: a standing party is a template, not an expedition.** It is not consumed.
It loses no units, however many trips it turns up in — exactly as a base's buildings
survive being raided. Its owner risks nothing by leaving it standing, and that is what
makes the passive side low-friction and fair to someone who isn't playing. It earns
Coin and Reputation when it succeeds.

## Design constraints that apply here

- **Composition** of living units + siege equipment, drawn from the roster in town.
- **Per-unit targeting stance**, exactly three: *nearest enemy*, *prioritize traps*, or
  *beeline for the caravan core*. Set here and **never changed live** — the owner is
  not present, so there is no live control by construction.
- **Approach edge(s) and starting positions** are part of the standing configuration.
  A party may split across multiple edges.
- **Persists until edited.** No expiry, no re-configuration ritual, no upkeep cost.
- **Units are never consumed or lost.** The party references roster units as a
  template; deployed instances are ephemeral copies. Any code path that damages,
  de-merges, or destroys a standing party's units is a bug — this is the guarantee
  that makes the passive side safe to leave up.
- A unit **may be both in the standing party and packed on a caravan trip**, because
  the party is a template rather than a physical deployment. Confirm this reads
  sensibly in the UI; the alternative (mutual exclusion) would punish players for
  having a party at all.
- Living units here use their **offense rating**, deliberately unequal to their defense
  rating — the best guard isn't automatically the best raider. Show both, emphasize offense.
- **Siege equipment is offense-only** and counters **specific** fence and trap
  categories. The owner picks it **blind to any particular caravan**, so siege choice
  is a standing bet on what kinds of circles it will meet — not a reaction. The builder
  must make the counter relationships legible so that bet is informed.
- Each unit type has **one ability on an automatic cooldown**, firing by itself. Since
  the owner is never present, the ability mix is a pure pre-commitment.
- **The party is scouted in full** by every player it is served to, before they arrange
  their circle against it. Its owner should know that — the builder should present the
  party as it will be seen, because designing something legible-but-hard-to-beat is the
  entire skill of this side of the game.
- Starting positions snap to the placement lattice, shown only while dragging.
- Only unlocked types are selectable; server re-validates.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `PARTY_SLOT_CAP` | 8 living units | Matched to `DEPLOYMENT_SLOT_CAP` so the two sides are comparably sized. Merged units are **slot-efficient** — a level-3 unit takes one slot where its four components would take four. That efficiency is the entire benefit of merging. |
| `SIEGE_SLOT_CAP` | 3 | Separate from unit slots. |
| `STANCES` | `nearest`, `traps`, `core` | Fixed by design — exactly these three. |
| `MAX_APPROACH_EDGES` | 4 (all sides) | Splitting across all four is legal. |
| `START_POSITION_BAND` | outermost 2 cells of the chosen edge | Snaps to the lattice. |
| `PARTY_EDIT_COOLDOWN` | none | Editing is free and instant. There is no reason to gate it, and gating it would create a Coin sink that sells convenience. |
| `PARTIES_PER_ACCOUNT` | 1 in MVP | Multiple standing parties is an obvious later extension; the schema should allow it. |
| `GRID_VISIBILITY` | visible only during an active place/drag | Same rule as chunks 08 and 17. |
| `TOUCH_TARGET_MIN` | 44px | Web-first, mobile-shaped. |

## Definition of done

- [ ] Party composition builder: living units + siege, both slot caps enforced.
- [ ] Per-unit stance assignment with the three stances.
- [ ] Approach edges and starting positions set as part of the standing config; the
      party can be split across edges.
- [ ] Party persists until edited; no expiry, no upkeep.
- [ ] **Units are never consumed.** A test serves the same party into many resolutions
      and asserts the owner's roster is byte-identical afterward — no damage, no
      de-merge, no loss.
- [ ] A unit can be in the standing party and packed on a trip simultaneously, and the
      UI explains that coherently.
- [ ] Offense and defense ratings shown separately, offense emphasized; abilities,
      attack range, and cooldowns shown.
- [ ] Siege counter relationships visible while building.
- [ ] Merge level and slot cost shown, making slot efficiency legible.
- [ ] **A preview of the party exactly as a scouting caravan will see it**, reachable
      from this screen.
- [ ] Results feed: where the party was served, whether it broke the caravan, and the
      replay of each fight.
- [ ] Unlock access validated server-side.
- [ ] Unit ordering and starting positions stored in a stable, explicit order — the
      resolver's tie-breaks depend on it.
- [ ] Lattice shown only during an active drag; touch-usable throughout.

## QA guardrail checks for this chunk

- **The party is never consumed — the load-bearing check:** run the same standing party
  through dozens of resolutions, including ones where it is annihilated, and confirm the
  owner's roster is untouched. If a standing party bleeds units, a player loses
  progress while not playing and with no chance to react, which is the failure mode
  async games work hardest to avoid.
- **No live control:** confirm nothing in resolution reads the party owner's input or
  state. They are not present by definition.
- **Legibility, both directions:** does the owner's preview match exactly what a
  scouting player sees? Any discrepancy favors hidden information, which the design
  forbids — and here it would let a party hide its composition from the person it
  attacks, breaking the game's central read-and-counter loop.
- **Bounded stakes:** slot caps enforced server-side.
- **Two stat profiles:** is a blended power number shown anywhere?
- **Access gate:** un-unlocked types must be rejected server-side.
- **No pay-to-win:** can Coin buy a bigger party, more siege slots, extra standing
  parties, or preferential placement into other players' trips? All would sell power.
- **Design fidelity:** is siege still a **counter to fences and traps** rather than a
  general damage buff? Since the owner picks blind, a general buff would be strictly
  better than any counter and would collapse the choice.
- **Determinism:** party configuration must serialize deterministically; it is
  snapshotted per encounter and must byte-compare.

## Build notes (2026-10-11)

**Where it lives.** `packages/circle/src/party.ts` (pure model: `TARGETING_STANCES`,
`PartyConfig` → `resolveParty(config, roster, isUnlocked)` → `Party`, `scoutParty`,
`siegeCounterEntry`), party serializers in `serialize.ts`, chunk 09 issue codes in
`issues.ts`; `apps/server/src/party/{repo,service,feed}.ts`, `routes/party.ts`
(`GET/PUT /me/party`, `GET /me/party/feed`), migration `006_standing_party_composition`,
the real `snapshotStandingParty` in `jobs/snapshots.ts`; tunables block in
`packages/content/src/tunables.ts`.

**Decisions and assumptions (confirm in QA):**
- **Stored = choices only.** `standing_party.composition` is a `PartyConfig` (`{v, units:
  [{ref, stance, edge, cell}], siege: [typeId]}`): instance ids, stances, edges, start
  cells, siege types. No stats, HP or merge level — those are joined from the live roster on
  every read, edit and snapshot. So a de-merge on the owner's own trip is reflected (the
  party rides the live level) and an instance that stops existing (lost on a trip, consumed
  by a merge) makes the party **invalid** (`unknown_ref`) at the next read/edit; `GET` reports
  `valid: false` + issues and keeps the choices, `PUT` refuses with the same issues until the
  ref is dropped, and `snapshotStandingParty` throws `StandingPartyInvalidError` rather than
  serve a party nobody scouted. **No FK** from a party unit to `unit_instance` on purpose:
  a cascade would silently trim, a restrict would block the merge/loss.
- **Each unit carries its own edge + cell** (cell must be in that edge's band;
  `MAX_APPROACH_EDGES` is the edge count, 4). Two units may share a start cell (units
  overlap freely). Siege types may not repeat (`duplicate_siege`): a counter applies once.
- **Canonical order:** units by ref (code-unit string order), siege by type id;
  `serializePartyConfig` / `serializeParty` are sorted-key, whitespace-free, integer-only;
  issue order follows canonical order.
- **Stance/edge enums are enforced by the strict parser** (400 `malformed_party`, names the
  allowed values); caps, band, duplicates, roster membership and access are validation issues
  (400 `invalid_party` + full list). Oversized bodies get one `oversized` issue.
- **Access:** living on each instance's caravan, siege on the account, via chunk 05's
  `accessCheckFor`; the predicate is the union over the account's caravans (exact with one
  caravan; with several same-region caravans it would over-approximate — tighten then).
- **Schema:** `standing_party` now has its own `id`, a per-account `slot` (unique
  `(account_id, slot)`), `composition` jsonb with a shape CHECK; identity immutable,
  `updated_at` moves iff composition changes, delete refused while the account exists,
  TRUNCATE refused. v1 uses slot 0 only (`PARTIES_PER_ACCOUNT` 1); the down migration deletes
  other slots before restoring the account-id key.
- **Events:** each real change appends one account-scoped `standing_party_saved`
  (`party_saved:<partyId>:<n>`, payload: partyId, slot, saveSeq, hash, counts, edges, config).
  A no-op save appends nothing. No cooldown exists (`PARTY_EDIT_COOLDOWN_MS` 0, asserted).
- **Feed** = the owner's `party_served_as_encounter` events joined with the same-causation
  `coin_earned` / `coin_transferred_to_defender` / siege `reputation_changed` /
  `ladder_progress_gained`, plus the defender caravan's name/region/username. Newest first,
  `before` cursor. Replays are chunk 13's (`jobId` is carried).
- **Snapshot shape** (`job.input.party`): `{ownerAccountId, partyId, slot, savedAt, hash,
  composition: Party}`; `partyFromJson(composition)` + `scoutParty` is the chunk 14 scout.
- **UI items deferred** to chunk 17's town screen (this chunk is server-side): the drag
  lattice, touch targets, the visual builder. The data for every UI bullet is in `GET
  /me/party` (`scout` preview, both ratings with `ratingInUse`, `slotCost`, `siegeCatalog`
  with `targetTypeIds`, `roster[].packedOnTrip/aliveOnTrip`, `rules`).
