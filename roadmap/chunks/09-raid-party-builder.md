# Chunk 09 — Raid party builder

**Depends on:** 03, 07. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

The offense-side configuration: assembling a raiding party (living units + siege),
assigning per-unit targeting stances, and — separately, per stop — choosing approach
edges and starting positions against a specific scouted camp.

**The two halves have different lifetimes and that is the central mechanic of this
chunk.** Do not collapse them.

## Design constraints that apply here

**Locked for the entire trip** (chosen once, before the trip starts, never changed):
- **Composition** of living units + siege equipment.
- **Per-unit targeting stance**: exactly three options — *nearest enemy*,
  *prioritize traps*, or *beeline for the caravan core*. **Locked in before the fight
  and never changed live.** There is no live control, no mid-fight reaction, no
  stance swap between stops.

**Chosen fresh at each stop** (based on that stop's scouted layout):
- **Starting position(s) along the chosen approach edge(s).**
- Attackers may **approach from any side, or split their party across multiple sides.**

Other constraints:

- Living units are the **same pool** as garrison units, but here they use their
  **offense rating** — which is deliberately not equal to their defense rating. The
  best guard isn't automatically the best raider. Show both, emphasize offense.
- **Siege equipment is offense-only** and functions as a **counter to fences and
  traps**: specific pieces reduce or bypass specific fence/trap categories. This
  makes siege loadout a **real pre-trip decision informed by scouting** — so the
  builder must let the player see siege counter relationships clearly, and ideally
  review a candidate camp before locking composition.
- **No swapping mid-trip**, and damage/losses carry forward between stops with **no
  healing until the trip ends**. The party the player locks in is the party they
  live with; the UI must make the stakes of that lock legible.
- A unit cannot be simultaneously garrisoned at the camp and out on a trip. Sending
  a party out changes what the camp looks like — surface that.
- Only unlocked types are selectable; server re-validates.
- `DEPLOYMENT_SLOT_CAP` bounds the party. This cap is what bounds catastrophic loss
  to a slot's worth of units rather than a whole collection — it is load-bearing.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `DEPLOYMENT_SLOT_CAP` | 8 | Shared with defense (chunk 07). Merged units are **slot-efficient**: a level-3 unit occupies one slot where its components would have occupied four. That efficiency is the entire benefit of merging. |
| `SIEGE_SLOT_CAP` | 3 | Separate from unit slots. |
| `STANCES` | `nearest`, `traps`, `core` | Fixed by design — exactly these three. |
| `MAX_APPROACH_EDGES` | 4 (all sides) | Splitting across all four is legal. |
| `START_POSITION_BAND` | outermost 2 tiles of the chosen edge | Where units may be placed. |

## Definition of done

- [ ] Party composition builder: living units + siege, both slot caps enforced.
- [ ] Per-unit stance assignment with the three stances, set before the trip.
- [ ] Composition and stances **lock at trip start** and cannot be edited until the
      trip ends — enforced server-side, tested.
- [ ] Approach edge(s) and starting positions chosen **per stop**, against that
      stop's scouted layout, and the party can be split across multiple edges.
- [ ] Units show offense and defense ratings separately, offense emphasized.
- [ ] Siege counter relationships are visible while building — which fence tiers and
      trap categories each piece answers.
- [ ] Current party damage and losses are visible when positioning at a later stop
      (no healing between stops).
- [ ] Merge level and its slot cost are shown, making slot efficiency legible.
- [ ] Unlock access validated server-side.
- [ ] Units garrisoned at the camp are handled coherently — a unit is in one place at a time.

## QA guardrail checks for this chunk

- **Design fidelity — the lock:** can composition or stance be changed after trip
  start by any path, including a direct API call between stops? The design says
  locked for the entire trip; a leak here changes what the player is actually doing.
- **Legibility:** can the player scout the camp and review siege counters **before**
  committing composition? Committing a trip-long loadout against unseen opposition
  would break the "preview before you commit resources" rule.
- **No live control:** confirm nothing in the resolution path reads player input.
  Stances are set before the fight and never changed live.
- **Bounded stakes:** slot caps enforced server-side. A party exceeding the cap
  would let a single trip risk more than the design's blast radius allows.
- **Two stat profiles:** is a blended power number shown anywhere? That collapses the
  offense/defense asymmetry.
- **Access gate:** un-unlocked types must be rejected server-side.
- **Determinism:** starting positions and unit ordering must be stored in a stable,
  explicit order — the resolver's tie-breaks depend on it.
