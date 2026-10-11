# Chunk 06 — QA punch list (commit d83e034, merged at 56a4305)

## Blocker
B1. Malformed server payload → blank page, no error boundary (main.tsx:8; WebsScreen.tsx:80/30/35; WebGraph.tsx:200; NodeCard.tsx:70). Validate the `/me/unlocks`, `/me/progression`, `/me` payloads at the client boundary (shape guards in api/client.ts → `ApiError(0,"bad_payload")` → ErrorBox + Retry) and wrap `<Routed>` in an error boundary rendering the same error/retry UI. These become scaffold conventions every later screen uses: document in apps/web/README.md.

## Should-fix
S1. ConfirmDialog: trap focus (or `<dialog>.showModal()`), `inert` the shell while open, restore focus to the opener on close, `aria-describedby` → body paragraph.
S2. NodeCard accessible name drops prerequisites and lock reason; let content be the name (glyphs `aria-hidden`).
S3. Pool tabs: implement roving tabindex + arrow keys + `aria-controls`/`aria-labelledby`, or use buttons with `aria-pressed`.
S4. Bottom sheet: move focus to its heading on open; return to the card on close.
S5. Typography: `html{font-size:100%}`, rem sizes, no px floors below 0.75rem; drop `-webkit-text-size-adjust:100%`.
S6. `accessGranted` copy kind-aware (trap/fence → "deploy it from the wagon-circle editor", siege → "add it to your party", living → "recruit it in town").
S7. Client must not derive lock reason or remainder; use the server's `missing`/`affordable`; quote the post-spend balance from the response/re-fetch.
S8. e2e asserts an exact cost per pool and one confirm→spend→re-fetch pass (seed points via a ledger insert in the e2e setup).

## Nits
N1. `sourcemap: 'hidden'` for production builds.
N2. Unmet prerequisite edges get a dash pattern, not colour only.
N3. Tier label overlaps first card by 3 px; add row top margin.
N4. Move catalogue.ts player-facing strings into strings.ts.
N5. Router: normalise the hash on fallback; `#/login` while signed in → `#/town`.
N6. client.ts: dotted `import.meta.env.VITE_API_BASE` (bracket access is dead).
N7. Manifest icons empty (chunk 34 note).
N8. Re-fetch before showing the confirm so the quoted balance is fresh.
