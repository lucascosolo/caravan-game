/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the `/api` prefix the client calls (vite.config.ts proxies that prefix in dev/preview). */
  readonly VITE_API_BASE?: string;
  /** "1" exposes `window.__isoDebug` in a production build (the e2e build only; chunk 08 QA N5). */
  readonly VITE_ISO_DEBUG?: string;
}
