import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // All test files share one Postgres database; run them one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    // Chunk 30: the suite registers hundreds of accounts from one address; the rate-limit tests pass their own limits.
    env: { CARAVAN_RATE_LIMITS: "off" },
    hookTimeout: 30_000,
  },
});
