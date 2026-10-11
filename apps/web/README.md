# @caravan/web

The client. Vite + React 18 + TypeScript strict, web-first and mobile-shaped (portrait,
thumb-reachable bottom tabs, 44px touch targets). It renders server state and stored battle
logs; it **never runs the simulation** and never decides eligibility on its own.

```
pnpm --filter @caravan/web dev        # http://127.0.0.1:5173, /api proxied to the server on :3000
pnpm --filter @caravan/web typecheck
pnpm --filter @caravan/web test       # vitest + testing-library (jsdom)
pnpm --filter @caravan/web build      # dist/ (hidden source maps)
pnpm --filter @caravan/web e2e        # playwright against the built app + a running seeded server
```

Layout: `src/api` (typed fetch client, payload guards, in-memory bearer token), `src/auth`
(session context), `src/shell` (hash router, tab bar, ErrorBox, ErrorBoundary),
`src/screens/*` (one folder per screen), `src/strings.ts` (every player-facing string),
`src/theme.css` (CSS variable theme, colourblind-safe palette: states and affinities carry an
icon or a word, never colour alone; type in rem off a 100% root so the player's text-size
setting is honoured).

The server is reached through `/api/*`; the Vite dev server and `vite preview` proxy that
prefix to `CARAVAN_API_URL` (default `http://127.0.0.1:3000`) and strip it.

## Scaffold conventions every screen follows

These were settled while closing chunk 06's QA punch list (`roadmap/qa/06-punchlist.md`).
A new screen (08, 17, 22, 23, 24) gets them by using the pieces below; it should not need
to reinvent any of them.

### 1. Payload guards: the client validates every response body (`src/api/shape.ts`)

The server is trusted to mean well, not to be right. A proxy error page, a half-deployed
server or a shape drift must never become a `TypeError` inside a render. So `createApi`
(`src/api/client.ts`) runs a **shape guard** over every 2xx body before a screen sees it
and turns a mismatch into `ApiError(0, "bad_payload", message, detail)` where `detail`
names the offending path (`GET /me/unlocks webs[1].nodes[0].tier: expected integer >= 0
<= 32, got number -1`).

`shape.ts` is a dependency-free validator with six combinators: `string`, `boolean`,
`integer` (refuses fractions, NaN, Infinity, strings; takes `min`/`max`), `literal`,
`nullable`, `optional`, `array` (takes `maxLength`), `object` (extra fields ignored). A guard
is `(value, path) => T`; `expectShape(guard, value)` runs one.

To add a route:

1. Declare its response interface in `src/api/types.ts` (hand-written, only the fields the
   client renders).
2. Declare its guard in `src/api/shapes.ts`, **typed against that interface** so TypeScript
   checks the two agree: `export const fooShape: Guard<FooResponse> = object({ ... })`.
   Put a bound on every number that sizes a render and a `maxLength` on every list.
3. Add the method to `Api` and wire it in `createApi` with the guard:
   `foo: () => request("GET", "/me/foo", fooShape)`. Pass `null` as the guard for a route
   whose answer carries nothing (204 / empty).

Status 0 on an `ApiError` means "no usable answer": `code` is `network` (fetch threw) or
`bad_payload`. Any other status carries the server's exact `{error, message}`.

### 2. Error presentation: `ErrorBox` + `ErrorBoundary` (`src/shell`)

- **`ErrorBox`** is the one way an `ApiError` is shown: a `role="alert"` box with a player
  message (status 0 is worded by code: "could not reach" / "could not read"; a real status
  shows the server's message), the `<status> <code>` line, the `detail` if any, and a
  **Retry** button when `onRetry` is given. A screen keeps its load error in state and
  renders `<ErrorBox error={e} heading={...} onRetry={() => void load()} />`; it keeps a
  separate error for an action (a spend) and shows that one without Retry, next to the thing
  that was tried.
- **`ErrorBoundary`** wraps `<Routed>` in `App.tsx`, so every screen is already covered: a
  throw during render shows the same ErrorBox (`render_error`, with the thrown error's text
  as detail) and a Retry that re-mounts the subtree from scratch. A screen that wants a
  narrower reset nests its own `<ErrorBoundary>`; it needs nothing else.

Guards are the first line (a bad body is an `ApiError` long before a render); the boundary
is the backstop for everything else.

### 3. Modal and focus

- `ConfirmDialog` (`src/screens/webs/ConfirmDialog.tsx`) is the modal pattern to reuse:
  portal into its own host under `<body>`, every other body child `inert` while open, Tab /
  Shift+Tab trapped inside, Escape cancels, `aria-labelledby` + `aria-describedby`, focus
  on the safe action on open, focus restored to the opener on close (or to a
  `restoreFocusTo` fallback when the opener is gone).
- A bottom sheet (`NodeDetail`) moves focus to its heading (`tabIndex={-1}`) when it opens or
  changes subject, and returns it to the element that opened it when it closes.
- A tablist uses a roving tabindex (one tab stop; arrows, Home, End move the selection) and
  `aria-controls` / `aria-labelledby` between tab and panel.
- A button's accessible name is its content: no `aria-label` that can fall behind what is
  drawn; decorative glyphs are `aria-hidden`.

### 4. Server state only

The client never derives a game fact it could read instead: no affordability, no "how many
points short", no post-spend remainder. Lock reasons come from the server's `missing` /
`affordable`; a balance after a spend is the one the spend response carries, and the screen
re-reads everything after any write. Before a confirm step that quotes numbers, re-fetch so
the quote is current.

### 5. Strings and theme

Every player-facing string is in `src/strings.ts` (including stat labels and unit formats:
nothing is interpolated from a literal inside a component or a formatter). Font sizes are
`rem` and never below `0.75rem`; the root is `100%`.

## e2e

`playwright.config.ts` starts `vite preview` (port `E2E_WEB_PORT`, default 4173) with its
`/api` proxy pointed at `CARAVAN_API_URL`. `pnpm e2e` at the repo root (`scripts/e2e.mjs`)
seeds a database, boots the built server on `E2E_PORT` (default 3917) and runs this. The spend
test registers a fresh account through the API and grants it unlock points the only way
points arrive, by inserting an `unlock_points_granted` ledger event (the projection trigger
folds it); it reads the database URL from `E2E_DATABASE_URL`, then `TEST_DATABASE_URL`, then
`DATABASE_URL`. `pg` is a devDependency for that insert only; the client bundle never
touches it.
