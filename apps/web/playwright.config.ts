import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke e2e (chunk 06): boots the BUILT app (`vite preview`, which proxies /api to the
 * server) and logs in as the seeded dev account. Needs a running server on a migrated,
 * seeded database:
 *
 *   DATABASE_URL=postgres://... pnpm db:migrate && DATABASE_URL=postgres://... pnpm db:seed
 *   DATABASE_URL=postgres://... PORT=3000 pnpm --filter @caravan/server dev
 *   pnpm --filter @caravan/web build && pnpm --filter @caravan/web e2e
 *
 * CARAVAN_API_URL (default http://127.0.0.1:3000) points the preview proxy at the server.
 * E2E_WEB_PORT (default 4173) is the preview port, so two checkouts can run side by side.
 */
const webPort = Number(process.env["E2E_WEB_PORT"] ?? 4173);

export default defineConfig({
  testDir: "./e2e",
  // The specs share one machine and a software WebGL canvas; the per-test budget is generous on purpose.
  timeout: 90_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    ...devices["Pixel 5"], // portrait phone viewport: the primary target (PHASE-2 §34)
  },
  webServer: {
    // E2E_WEB_DIST: `pnpm e2e` serves a VITE_ISO_DEBUG=1 build (dist-e2e) so the specs can aim through window.__isoDebug (chunk 08 QA N5).
    command: `pnpm exec vite preview --port ${webPort} --strictPort --outDir ${process.env["E2E_WEB_DIST"] ?? "dist"}`,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
