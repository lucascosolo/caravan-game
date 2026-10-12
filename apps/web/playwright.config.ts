import { defineConfig, devices } from "@playwright/test";

/**
 * The web e2e (chunk 06). Two ways to run it, both driven by scripts/e2e.mjs:
 *
 *   `pnpm e2e`          boots the BUILT client with `vite preview`, which proxies /api to the
 *                       built server (CARAVAN_API_URL, default http://127.0.0.1:3000). E2E_WEB_PORT
 *                       (default 4173) is the preview port, so two checkouts can run side by side.
 *   `pnpm e2e:hosting`  final review S2: E2E_BASE_URL names the built server itself, running with
 *                       SERVE_WEB=1 (it serves the client and the API under /api); no preview server.
 *
 * Either needs a migrated database seeded by `seed.js --dev` (scripts/e2e.mjs does both).
 */
const webPort = Number(process.env["E2E_WEB_PORT"] ?? 4173);
const hostedBase = process.env["E2E_BASE_URL"] || null;

export default defineConfig({
  testDir: "./e2e",
  // The specs share one machine and a software WebGL canvas; the per-test budget is generous on purpose.
  timeout: 90_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: hostedBase ?? `http://127.0.0.1:${webPort}`,
    ...devices["Pixel 5"], // portrait phone viewport: the primary target (PHASE-2 §34)
  },
  ...(hostedBase
    ? {}
    : {
        webServer: {
          // E2E_WEB_DIST: `pnpm e2e` serves a VITE_ISO_DEBUG=1 build (dist-e2e) so the specs can aim through window.__isoDebug (chunk 08 QA N5).
          command: `pnpm exec vite preview --port ${webPort} --strictPort --outDir ${process.env["E2E_WEB_DIST"] ?? "dist"}`,
          url: `http://127.0.0.1:${webPort}`,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
});
