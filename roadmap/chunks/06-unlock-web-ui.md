# Chunk 06 — Unlock web UI

**Depends on:** 05. **Status:** built (2026-10-11; see "Build notes" at the end); QA punch
list `roadmap/qa/06-punchlist.md` fully closed the same day (see "QA fixes"), awaiting re-audit.
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

- [x] All three webs browsable; whole graph visible including unreachable nodes.
- [x] Each node shows: name, cost, prerequisites, full stats of what it grants,
      and its current state (locked / affordable / reached).
- [x] Point balance and next-rung progress are visible on each web.
- [x] Purchase flow shows cost and confirms before committing.
- [x] UI copy distinguishes **access** from **owning an instance** unambiguously.
- [x] Trap/siege webs labelled account-level; living web labelled caravan/region-scoped.
- [x] Node layout is stable across sessions and reloads.
- [x] Client never decides affordability or eligibility on its own — it displays
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

## Build notes (2026-10-11, Maker)

Built as `apps/web/src/screens/webs/*` on the new client scaffold (see AGENTS.md "Web
client"). What QA should know:

- **Server state only.** The screen reads `GET /me/unlocks` (every node with `cost`,
  `reached`, `affordable`, `missing`), `GET /me/progression` (ladder rung, next rung and
  what it grants) and `GET /me` (caravan names). The client computes no affordability; it
  renders the node's own `cost` and state. There is no shared tier table on the client —
  costs are per pool (chunk 05 QA D1) and read from each node's payload.
- **Spend flow.** Tap a node → bottom sheet (full stat block, prerequisites by name, the
  "grants access, does not give you one" line) → `Unlock access to X for N pts` (rendered
  only when the server flagged the node affordable) → modal confirm quoting cost, points
  available and the remainder → `POST /me/unlocks/spend {pool, nodeId, caravanId?}`
  (caravanId only for the living web) → re-fetch all three reads. No optimistic update.
  A refusal shows the server's exact `message` with `<status> <code>` under it (tested
  with a 409 `insufficient_points`).
- **Locked nodes show their stats** (`SHOW_LOCKED_NODE_STATS`): the stat block comes from
  `@caravan/content` (public, pure data) via `catalogue.ts`; fixed-point values are
  converted to decimal text there, display-only, integer arithmetic.
- **Layout** (`WEB_LAYOUT`): rather than authored coordinates, the graph is laid out by
  tier (one row per tier, top-down, nodes in authored order within a row) with
  prerequisite edges drawn from measured card positions. A pure function of the authored
  node list, so identical across loads and players; authored coordinates can replace it
  later without touching the data shape. Decision taken because the webs are ≤10 nodes
  and ≤3 per tier, where a layered layout reads cleanly in portrait.
- **Scope labels.** Trap/siege: "Account-level: shared by every caravan you will ever
  run." Living: "Caravan-level, <Region> only: belongs to “<caravan>” and does not transfer
  to another caravan."
- **State is never colour-only:** reached ✓ / affordable → / locked ⊘ plus the word, plus
  border style; affinities are square / triangle / circle plus the word.
- **Tests:** `apps/web/src/screens/webs/WebsScreen.test.tsx` (6): every node of every pool
  rendered with its cost including unaffordable and unreachable ones (per-pool curve
  asserted: siege tier 2 = 8, trap tier 4 = 10); a locked node's full stat block and the
  access-not-instance copy; confirm-before-spend (no POST on open, none on cancel, exactly
  one on confirm with the server's body shape, bearer header, then a second GET and the
  re-fetched state shown); caravanId on a living spend; exact 409 message surfaced; load
  error with retry. Plus `api/client.test.ts` (error body, 401 hook, no storage) and the
  router. `e2e/smoke.spec.ts` logs in as the seeded `dev` account and checks both webs,
  a locked capstone's cost and stat sheet.
- **Not built, deliberately:** nothing offers to buy points or nodes with Coin; there is no
  client-side `checkSpend` preview (the server's `affordable` flag is the preview).

## QA fixes (2026-10-11, Maker closing `roadmap/qa/06-punchlist.md`)

What changed against the build notes above; the punch list carries the per-item closures.

- **Payload guards and an error boundary are now scaffold conventions** (B1). The API client
  validates every 2xx body against a guard in `src/api/shapes.ts` (bounds: tier 0..32, lists
  capped) and raises `ApiError(0, "bad_payload")` with the offending path; a malformed
  `/me/unlocks`, `/me/progression`, `/me` or spend answer shows `ErrorBox` + Retry instead of
  a blank page. `ErrorBoundary` (`src/shell`) wraps the routed screens. Both are written up
  in `apps/web/README.md` so chunk 08 and later screens adopt them unchanged.
- **The client derives nothing** (S7, N8). The lock reason is the server's `missing` list, or
  "Not enough points yet" when `affordable` is false with nothing missing; there is no "N more
  points needed" and no remainder in the confirm. Tapping Unlock re-fetches first and only
  opens the confirm if the fresh read still says affordable; the quote is that read's cost and
  balance. The post-spend notice quotes `points.available` from the spend response, and the
  dialog stays busy until all three views are re-read.
- **Accessibility** (S1–S5): a real modal (portal, `inert` page, focus trap, Escape, focus
  restored to the opener); content-named cards with hidden glyphs; a roving-tabindex tablist
  with arrow keys and `aria-controls`; the sheet focuses its heading and returns focus to the
  card; type in rem off a 100% root, floor 0.75rem. Checked at 150% root scale: no overflow,
  nothing clipped.
- **Copy** (S6): the reached-state line is per kind — unit "recruit it in town", trap / fence
  "deploy it from the wagon-circle editor", siege "add it to your party" — each ending "this
  node gives no instance".
- **Nits**: hidden source maps; dashed unmet edges; tier label clear of the cards; catalogue
  strings in `strings.ts`; canonical hash rewrite and `#/login` → `#/town` when signed in;
  dotted `import.meta.env`; a placeholder SVG app icon (chunk 34 owns the real set).
- **Tests**: `WebsScreen.test.tsx` 30 (was 6: +15 malformed-payload cases, spend-shape, XSS as
  text, S1×2, S2, S3, S4, S6, N8, retry), `shape.test.ts` 5, `ErrorBoundary.test.tsx` 1,
  `router.test.ts` 3, `client.test.ts` 2 → 41. `e2e/smoke.spec.ts` 2: exact costs per pool,
  and a fresh-account confirm → spend → re-fetch pass with points granted by an
  `unlock_points_granted` ledger insert (S8), checked against `GET /me/unlocks`.
