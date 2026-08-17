# Chunk 06 — Unlock web UI

**Depends on:** 05. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

A browsable view of all three unlock webs where the player can see the entire tree,
every cost, and everything a node grants, before spending a single point.

## Design constraints that apply here

- The web is **visible and non-random**. Show the whole thing — including nodes the
  player cannot yet afford and nodes far past their current progress. Nothing is
  fogged, teased, or revealed progressively. The player plans against the full map.
- **Unlock costs are visible before spending.** So are prerequisites and the full
  stat block of whatever the node grants access to — a player choosing between two
  nodes is making an informed build decision, not a guess.
- A node grants **access to recruit/deploy**, not an instance. The UI must say this
  plainly, or players will misread unlocking as acquiring and feel cheated.
- Three separate webs, and the UI must reflect the scope split honestly: trap and
  siege webs are **account-level** (shared across future caravans); the living-unit
  web is **caravan-level and region-specific** (does not transfer). Labelling this
  costs nothing now and prevents a nasty surprise when multi-caravan ships.
- Show the point economy clearly: points granted, points spent, points available,
  and where the next points come from (the next ladder rung and how far it is).

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `WEB_LAYOUT` | authored node coordinates in the content data | Not auto-laid-out at runtime — a stable, hand-placed graph reads better and stays deterministic across sessions. |
| `SHOW_LOCKED_NODE_STATS` | full stats visible on locked nodes | Legibility. Do not gate stat display behind unlocking. |

## Definition of done

- [ ] All three webs browsable; whole graph visible including unreachable nodes.
- [ ] Each node shows: name, cost, prerequisites, full stats of what it grants,
      and its current state (locked / affordable / reached).
- [ ] Point balance and next-rung progress are visible on each web.
- [ ] Purchase flow shows cost and confirms before committing.
- [ ] UI copy distinguishes **access** from **owning an instance** unambiguously.
- [ ] Trap/siege webs labelled account-level; living web labelled caravan/region-scoped.
- [ ] Node layout is stable across sessions and reloads.
- [ ] Client never decides affordability or eligibility on its own — it displays
      server state and the server re-validates every purchase.

## QA guardrail checks for this chunk

- **Legibility:** can the player preview everything before committing? Are unlock
  costs, prerequisites, and granted stats all visible before spending? Is anything
  hidden that the design says should be visible? Locked nodes specifically must not
  hide their stats.
- **Access vs. instance:** does any UI string imply unlocking gives you the unit?
  This is a real misread risk and a legibility failure.
- **Client-side gate only:** try to purchase a node with prerequisites unmet by
  calling the API directly, bypassing the UI. It must be refused server-side. A
  greyed-out button is not enforcement.
- **No pay-to-win:** does any surface offer to buy points, buy a node, or accelerate
  the web with Coin? There must be none.
- **Determinism:** does the displayed web ever differ between two loads for the same
  player?
