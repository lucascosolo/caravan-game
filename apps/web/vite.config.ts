import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The client talks to the server through `/api/*` (see src/api/client.ts). In dev and in
 * `vite preview` that prefix is proxied to the Fastify server and stripped, so the browser
 * never needs CORS and the built app can sit behind the same reverse-proxy rule later.
 * CARAVAN_API_URL overrides the target (the e2e run points it at its own server port).
 */
const apiTarget = process.env["CARAVAN_API_URL"] ?? "http://127.0.0.1:3000";
const proxy = {
  "/api": { target: apiTarget, changeOrigin: true, rewrite: (path: string) => path.replace(/^\/api/, "") },
};

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, proxy },
  preview: { host: "127.0.0.1", port: 4173, proxy },
  // Hidden source maps (QA-06 N1): emitted for error tooling, not referenced from the bundle.
  build: { outDir: "dist", sourcemap: "hidden", target: "es2022" },
});
