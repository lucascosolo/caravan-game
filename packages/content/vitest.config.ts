import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The invariant sweeps (every type × role × opponent × affinity) are CPU-heavy and exceed
    // vitest's 5 s default on a loaded runner; 60 s matches the server suite. No assertion changes.
    testTimeout: 60_000,
  },
});
