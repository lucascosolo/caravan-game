# @caravan/web

The client. Vite + React 18 + TypeScript strict, web-first and mobile-shaped (portrait,
thumb-reachable bottom tabs, 44px touch targets). It renders server state and stored battle
logs; it **never runs the simulation** and never decides eligibility on its own.

```
pnpm --filter @caravan/web dev        # http://127.0.0.1:5173, /api proxied to the server on :3000
pnpm --filter @caravan/web typecheck
pnpm --filter @caravan/web test       # vitest + testing-library (jsdom)
pnpm --filter @caravan/web build      # dist/
pnpm --filter @caravan/web e2e        # playwright smoke against the built app + a running seeded server
```

Layout: `src/api` (typed fetch client, in-memory bearer token), `src/auth` (session
context), `src/shell` (hash router + tab bar), `src/screens/*` (one folder per screen),
`src/strings.ts` (every player-facing string), `src/theme.css` (CSS variable theme,
colourblind-safe palette: states and affinities carry an icon or a word, never colour alone).

The server is reached through `/api/*`; the Vite dev server and `vite preview` proxy that
prefix to `CARAVAN_API_URL` (default `http://127.0.0.1:3000`) and strip it.
