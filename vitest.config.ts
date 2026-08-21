import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Alias workspace packages straight to source so `vitest run` never depends
// on a prior `tsc -b` having populated dist/ — package.json's main/types
// still point at dist for the real (production) build.
export default defineConfig({
  resolve: {
    alias: {
      "@caravan/content": fileURLToPath(new URL("./packages/content/src/index.ts", import.meta.url)),
      "@caravan/resolver": fileURLToPath(new URL("./packages/resolver/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
