import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    // QA-13 S6: a macrotask yield before every test (see the file).
    setupFiles: ["./test/setup-yield.ts"],
  },
});
