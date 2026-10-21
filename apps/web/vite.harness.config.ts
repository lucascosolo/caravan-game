import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// C3 dev-only camp harness (camp-harness.html): `vite build -c vite.harness.config.ts --outDir <dir>`
// (run `pnpm art:build` first). One self-contained HTML file that opens from file://: the atlas
// images are inlined as data: URLs (a file:// image would taint the canvas) and the script is
// inlined into the page (a file:// module script is blocked).
const PUBLIC = path.resolve(__dirname, "public");

function inlineAtlas(): Plugin {
  return {
    name: "c3-inline-atlas",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("art/generated/manifest.json")) return null;
      const m = JSON.parse(code) as { scenes: Record<string, { files: Record<string, { webp: string; png: string }> }> };
      for (const sc of Object.values(m.scenes))
        for (const f of Object.values(sc.files)) {
          f.png = `data:image/png;base64,${readFileSync(path.join(PUBLIC, f.png.split("?")[0]!)).toString("base64")}`;
          f.webp = f.png;
        }
      return { code: JSON.stringify(m), map: null };
    },
  };
}

function inlineScript(): Plugin {
  return {
    name: "c3-inline-script",
    enforce: "post",
    generateBundle(_, bundle) {
      const html = Object.values(bundle).find((b) => b.type === "asset" && b.fileName.endsWith(".html"));
      if (!html || html.type !== "asset") return;
      let page = String(html.source);
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === "chunk") {
          page = page.replace(new RegExp(`<script type="module" crossorigin src="[^"]*${chunk.fileName.split("/").pop()!.replace(/\./g, "\\.")}"></script>`), () => `<script type="module">${chunk.code.replace(/<\/script/g, "<\\/script")}</script>`);
          delete bundle[name];
        } else if (chunk.fileName.endsWith(".css")) {
          page = page.replace(new RegExp(`<link rel="stylesheet" crossorigin href="[^"]*${chunk.fileName.split("/").pop()!.replace(/\./g, "\\.")}">`), () => `<style>${String(chunk.source)}</style>`);
          delete bundle[name];
        }
      }
      html.source = page;
    },
  };
}

export default defineConfig({
  plugins: [react(), inlineAtlas(), inlineScript()],
  base: "./",
  publicDir: false,
  build: { rollupOptions: { input: "camp-harness.html", output: { inlineDynamicImports: true } }, modulePreload: false, target: "es2022", assetsInlineLimit: 1e8 },
});
