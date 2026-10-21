import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-only static build of gallery.html for screenshots (C4a): `vite build -c vite.gallery.config.ts --outDir <dir>`.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { rollupOptions: { input: ["gallery.html", "gallery-results.html"] }, modulePreload: false, target: "es2022" },
});
