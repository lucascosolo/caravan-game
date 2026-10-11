/**
 * Chunk 29: a tiny in-memory signal between the Inbox screen and the shell's unread badge. When
 * the screen gets a fresh inbox from the server (after a read or a preference change) it
 * publishes the SERVER's unread count; the badge shows it at once instead of waiting for its
 * next poll. In memory only — no storage of any kind; the server is the only record.
 */
type Listener = (unreadCount: number) => void;

const listeners = new Set<Listener>();

export function publishUnread(unreadCount: number): void {
  for (const l of listeners) l(unreadCount);
}

export function onUnread(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * TUNABLE (presentation, not balance). How often the open app asks the server for the unread
 * count. PHASE-2 §29's "learns within a minute" for a player who has the game open; there is no
 * device push yet (PWA / chunk 34), so a closed app learns on its next open.
 */
export const INBOX_POLL_MS = 60_000;
