# Chunk 06 — QA punch list (commit d83e034, merged at 56a4305)

Status: **all items closed** by the fixer on 2026-10-11 (see the chunk file's "QA fixes"
and the ORCHESTRATION entry). Each item below keeps its original text with the closure
noted under it.

## Blocker
B1. Malformed server payload → blank page, no error boundary (main.tsx:8; WebsScreen.tsx:80/30/35; WebGraph.tsx:200; NodeCard.tsx:70). Validate the `/me/unlocks`, `/me/progression`, `/me` payloads at the client boundary (shape guards in api/client.ts → `ApiError(0,"bad_payload")` → ErrorBox + Retry) and wrap `<Routed>` in an error boundary rendering the same error/retry UI. These become scaffold conventions every later screen uses: document in apps/web/README.md.
  - [closed] `src/api/shape.ts` (combinator validator, no dependency) + `src/api/shapes.ts` (guards typed against `types.ts` for `/me`, `/me/unlocks`, `/me/progression`, `/me/unlocks/spend`, auth); `createApi` runs the guard on every 2xx body → `ApiError(0, "bad_payload", …, detail=path)`; tier bounded 0..32, every list bounded. `src/shell/ErrorBoundary.tsx` wraps `<Routed>` (`render_error`, Retry re-mounts). `ErrorBox` moved to `src/shell/ErrorBox.tsx` (re-exported from WebsScreen). Tests: 15 malformed-payload cases + spend + XSS-as-text in `WebsScreen.test.tsx`, `shape.test.ts`, `ErrorBoundary.test.tsx`. Documented in `apps/web/README.md` §1–2.

## Should-fix
S1. ConfirmDialog: trap focus (or `<dialog>.showModal()`), `inert` the shell while open, restore focus to the opener on close, `aria-describedby` → body paragraph.
  - [closed] Portal host under `<body>`, every other body child `inert`, Tab/Shift+Tab cycle, Escape cancels, `aria-describedby` → body, focus restored to the opener (or `restoreFocusTo` → sheet heading when the opener is gone after a successful spend). Two tests.
S2. NodeCard accessible name drops prerequisites and lock reason; let content be the name (glyphs `aria-hidden`).
  - [closed] `aria-label` removed; name is the content (name, affinity, cost, state, prerequisites, reason); state glyph and affinity SVG `aria-hidden`. Test asserts the exact accessible name.
S3. Pool tabs: implement roving tabindex + arrow keys + `aria-controls`/`aria-labelledby`, or use buttons with `aria-pressed`.
  - [closed] Roving tabindex, ArrowLeft/Right/Home/End, `aria-controls` ↔ `aria-labelledby`. Test.
S4. Bottom sheet: move focus to its heading on open; return to the card on close.
  - [closed] Heading `tabIndex=-1` focused on open and on node change; focus returns to that node's card on close. Test, plus an e2e assertion.
S5. Typography: `html{font-size:100%}`, rem sizes, no px floors below 0.75rem; drop `-webkit-text-size-adjust:100%`.
  - [closed] All of it; probe at 360×640: root pref 24px scales `.node__cost` 13→19.5px; 150% root: 0px horizontal overflow, no clipped controls, no tier-label overlap.
S6. `accessGranted` copy kind-aware (trap/fence → "deploy it from the wagon-circle editor", siege → "add it to your party", living → "recruit it in town").
  - [closed] `STRINGS.webs.accessGranted(kind)`; test covers all four kinds.
S7. Client must not derive lock reason or remainder; use the server's `missing`/`affordable`; quote the post-spend balance from the response/re-fetch.
  - [closed] `lockedReason(node)` uses only `missing` / `affordable` ("Not enough points yet", no shortfall arithmetic); confirm body no longer computes a remainder; the notice quotes `points.available` from the spend response, then everything is re-read.
S8. e2e asserts an exact cost per pool and one confirm→spend→re-fetch pass (seed points via a ledger insert in the e2e setup).
  - [closed] `e2e/smoke.spec.ts`: Vaquero 14 pts / Stacked Stone 10 pts / Fence Cutters 8 pts / Blasting Crate 21 pts; second test registers a fresh account, inserts an `unlock_points_granted` ledger event (5 pts, trap, rung 1) through `pg`, walks cancel then confirm→spend→re-fetch in the UI (exactly one POST, notice "4 unlock points remain", card Reached, available 4 / spent 1) and checks `GET /me/unlocks` agrees. Two consecutive runs green.

## Nits
N1. `sourcemap: 'hidden'` for production builds. — [closed]
N2. Unmet prerequisite edges get a dash pattern, not colour only. — [closed] `.graph__edge--unmet { stroke-dasharray: 6 5 }`; probe confirms met edges solid, unmet dashed.
N3. Tier label overlaps first card by 3 px; add row top margin. — [closed] row `padding-top: 1.25rem`, label at `top: 0`; probe: 8px gap on every tier at 100% and 150%.
N4. Move catalogue.ts player-facing strings into strings.ts. — [closed] `STRINGS.webs.stat.*` gained radius / oneHit / heals / bonusDamage / duration / distance / fenceDamage / effectRoot / effectSlow / countersValue.
N5. Router: normalise the hash on fallback; `#/login` while signed in → `#/town`. — [closed] `readRoute()` rewrites any non-canonical hash with `replaceState` (case-insensitive, `#//webs`, `#/webs#x`, `#/nope` → `#/town`); `App` replaces `#/login` with `#/town` once signed in. Tests.
N6. client.ts: dotted `import.meta.env.VITE_API_BASE` (bracket access is dead). — [closed] plus `src/vite-env.d.ts` typing it.
N7. Manifest icons empty (chunk 34 note). — [closed] placeholder `public/icon.svg` (wagon wheel, `sizes: any`) referenced from the manifest; the real icon set stays with chunk 34.
N8. Re-fetch before showing the confirm so the quoted balance is fresh. — [closed] Unlock tap re-fetches; the confirm opens only if the fresh read still says affordable, else a status line says the web was refreshed; the quote is snapshot from that read. Test.
