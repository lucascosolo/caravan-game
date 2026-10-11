import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // Every file starts from the same database baseline, whatever ran before it (order-independence).
    setupFiles: ["./test/per-file-reset.ts"],
    // All test files share one Postgres database; run them one at a time.
    fileParallelism: false,
    // A test that seeds the 96 authored parties takes 8-11 s on a lightly loaded 4-core box; a busy
    // host doubles that, and 20 s timed those tests out (load, not order). A hang still fails.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Chunk 30: the suite registers hundreds of accounts from one address; the rate-limit tests pass their own limits.
    env: { CARAVAN_RATE_LIMITS: "off" },
  },
});
