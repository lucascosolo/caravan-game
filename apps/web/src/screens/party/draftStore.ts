/**
 * The party builder's unsaved draft, kept IN MEMORY across tab switches (QA-17 S4). Leaving
 * the Party tab unmounts the screen; coming back restores the edits instead of silently
 * dropping them. Never persisted: a reload of the page starts from the saved party, and
 * sign-out forgets it (`onViewerReset`). Keyed by the party's id, so it can never be shown
 * against a different account's party.
 */
import type { PartyConfig } from "@caravan/circle";
import { onViewerReset } from "../../auth/session.tsx";

interface Kept {
  readonly partyId: string;
  readonly draft: PartyConfig;
}

let kept: Kept | null = null;

onViewerReset(() => {
  kept = null;
});

/** The unsaved draft for this party, if one was left behind. */
export function keptDraft(partyId: string): PartyConfig | null {
  return kept && kept.partyId === partyId ? kept.draft : null;
}

/** Remember an unsaved draft (or forget it: `null` once saved, reloaded or discarded). */
export function keepDraft(partyId: string, draft: PartyConfig | null): void {
  kept = draft ? { partyId, draft } : null;
}
