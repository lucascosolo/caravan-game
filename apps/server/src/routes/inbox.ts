/**
 * The in-app inbox (chunk 29). All account-scoped: the caller's own inbox only.
 *
 *   GET  /me/inbox               items (derived on read, newest first), unread count, preferences
 *   GET  /me/inbox/unread        just the unread count: the app shell's badge polls this
 *   POST /me/inbox/read          { all: true } | { marks: [{ key, version }] } → the inbox after
 *   PUT  /me/inbox/preferences   { preferences: { <category>: boolean } }      → the inbox after
 *
 * No route sends anything to a device: there is no push yet (PWA web push and native push are
 * chunk 34's packaging work); the inbox is the fallback AND the record (§29). The wall clock
 * enters as `Date.now()` here only — it decides which timers have come due, never an outcome.
 */
import type { FastifyInstance } from "fastify";
import { markRead, readInbox, readUnread, savePreferences } from "../inbox/service.js";
import { requireAuth } from "./require-auth.js";

export async function inboxRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/inbox", { preHandler: requireAuth }, async (req) => readInbox(app.db, req.auth!.account.id, Date.now()));

  app.get("/me/inbox/unread", { preHandler: requireAuth }, async (req) => readUnread(app.db, req.auth!.account.id, Date.now()));

  app.post("/me/inbox/read", { preHandler: requireAuth }, async (req) => markRead(app.db, req.auth!.account.id, req.body ?? null, Date.now()));

  app.put("/me/inbox/preferences", { preHandler: requireAuth }, async (req) => savePreferences(app.db, req.auth!.account.id, req.body ?? null, Date.now()));
}
