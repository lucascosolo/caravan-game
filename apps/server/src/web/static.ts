/**
 * Single-process hosting of the built client (final review S2, SERVE_WEB=1).
 *
 * The API is mounted under /api by buildApp; this plugin answers every other GET / HEAD from the
 * built client directory (apps/web/dist):
 *
 *   - `/` and any path that is not a file → index.html (the client uses a hash router, so this is
 *     only the entry point and a friendly answer to a deep link), `Cache-Control: no-cache`;
 *   - `/assets/*` (Vite's content-hashed bundles) → `Cache-Control: public, max-age=31536000, immutable`;
 *   - other files (manifest, icon) → `Cache-Control: public, max-age=3600`;
 *   - `*.map` → 404 under NODE_ENV=production (the build keeps hidden source maps for error tooling;
 *     they are never published to players);
 *   - a path that escapes the directory (`..`, encoded or not), a dotfile or a NUL → 404;
 *   - `/api/…` that no API route matched → the same JSON 404 Fastify sends for an unknown route.
 *
 * Every response from this plugin carries the security headers below. The CSP allows only this
 * origin for scripts, styles, images, workers and fetches (plus `data:` / `blob:` images and
 * workers, which PixiJS uses for textures and its worker pool); there are no inline scripts in the
 * build. API responses are JSON and get `nosniff` from the API plugin's hook in app.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ServeWebConfig } from "../config.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function webSecurityHeaders(reply: FastifyReply, production: boolean): void {
  void reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
  // Production is served over HTTPS only (docs/PLAYTEST-HOSTING.md); browsers ignore this header on http.
  if (production) void reply.header("strict-transport-security", "max-age=31536000");
  void reply.header("x-content-type-options", "nosniff");
  void reply.header("referrer-policy", "no-referrer");
  void reply.header("x-frame-options", "DENY");
  void reply.header("cross-origin-opener-policy", "same-origin");
  void reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

/** The file under `root` a URL path names, or null when it names nothing servable. Pure apart from fs. */
export function resolveWebFile(root: string, urlPath: string, production: boolean): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = path.posix.normalize(decoded).replace(/^\/+/, "");
  if (rel === "" || rel === ".") return null;
  if (rel.split("/").some((seg) => seg === ".." || seg.startsWith("."))) return null;
  if (production && rel.endsWith(".map")) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

function sendApiNotFound(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 });
}

export async function webStaticRoutes(app: FastifyInstance, cfg: ServeWebConfig): Promise<void> {
  const root = path.resolve(cfg.dir);
  const indexPath = path.join(root, "index.html");
  if (!existsSync(indexPath)) throw new Error(`webStaticRoutes: ${indexPath} does not exist`);
  // Read once: the entry point is tiny and must never be served stale from a half-written build.
  const indexHtml = readFileSync(indexPath);

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const urlPath = req.url.split("?")[0]!;
    if (urlPath === "/api" || urlPath.startsWith("/api/")) return sendApiNotFound(req, reply);
    webSecurityHeaders(reply, cfg.production);
    const file = resolveWebFile(root, urlPath, cfg.production);
    if (file === null) {
      // A missing asset is a real 404 (a stale tab asking for an old bundle must not get HTML).
      if (urlPath.startsWith("/assets/") || /\.[A-Za-z0-9]{1,12}$/.test(urlPath)) {
        return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
      }
      return reply.code(200).type(TYPES[".html"]!).header("cache-control", "no-cache").send(indexHtml);
    }
    if (file === indexPath) return reply.code(200).type(TYPES[".html"]!).header("cache-control", "no-cache").send(indexHtml);
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] ?? "application/octet-stream";
    const cache = urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600";
    return reply.code(200).type(type).header("cache-control", cache).send(createReadStream(file));
  };

  app.get("/", handler);
  app.get("/*", handler);
}
