/**
 * Final play-test review r4 N5: a fight this device committed whose replay has not opened yet.
 * The commit remembers (manifest id, encounter index); the next read of that encounter's result
 * opens the replay playing, even after a reload mid-resolve, and forgets it. One entry at a time.
 *
 * A per-viewer convenience under the viewer prefix (cleared on sign-out, never read by the
 * server). Storage blocked or empty: no entry, and only the in-memory "committed just now" path
 * autoplays, as before.
 */
import { VIEWER_STORAGE_PREFIX } from "../../auth/session.tsx";

const KEY = `${VIEWER_STORAGE_PREFIX}fight.committed`;

export function rememberCommitted(manifestId: string, encounterIndex: number): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ manifestId, encounterIndex }));
  } catch {
    // Storage blocked: nothing is remembered.
  }
}

/** True once when (manifestId, encounterIndex) is the remembered commit; the entry is then dropped. */
export function takeCommitted(manifestId: string, encounterIndex: number): boolean {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return false;
    const v = JSON.parse(raw) as { manifestId?: unknown; encounterIndex?: unknown };
    if (v.manifestId !== manifestId || v.encounterIndex !== encounterIndex) return false;
    window.localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
