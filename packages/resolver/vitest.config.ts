import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    // QA-13 S6: a macrotask yield before every test (see the file).
    setupFiles: ["./test/setup-yield.ts"],
    // PHASE-2 §36: budget.test.ts collects garbage before each timed run (it changes no result).
    poolOptions: { forks: { execArgv: ["--expose-gc"] } },
  },
});
