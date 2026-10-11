/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the `/api` prefix the client calls (vite.config.ts proxies that prefix in dev/preview). */
  readonly VITE_API_BASE?: string;
}
