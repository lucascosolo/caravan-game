# Chunk 09 — Standing raid party

**Depends on:** 03, 05, 07. **Status:** not started.
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
