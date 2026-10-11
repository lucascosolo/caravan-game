/**
 * The refugee menu's display model (chunk 17 UI for chunk 18). PURE.
 *
 * The server decides everything: which offers, whether the free menu is due, what the next
 * reroll costs. This file only (1) collapses duplicate slots — a pool smaller than three
 * repeats a type, and showing "Dust Rider" three times reads as three different offers —
 * and (2) counts the free-menu countdown down from the server's `msUntilFreeRefresh`
 * between reads. When the countdown reaches zero the screen RE-READS the menu (GET never
 * writes) and shows the server's `freeRefreshDue`; it never decides that by itself.
 */
import type { RefugeeOfferView, RefugeeView } from "../../api/types.ts";

export interface CollapsedOffer {
  readonly unitTypeId: string;
  readonly displayName: string;
  readonly affinity: string;
  readonly abilityName: string;
  /** How many of the menu's slots offer this type (≥ 1). */
  readonly times: number;
  /** The lowest slot index that offers it (stable order on screen). */
  readonly firstSlot: number;
}

export function collapseOffers(offers: readonly RefugeeOfferView[]): readonly CollapsedOffer[] {
  const map = new Map<string, { o: RefugeeOfferView; times: number; firstSlot: number }>();
  for (const o of offers) {
    const prev = map.get(o.unitTypeId);
    if (prev) map.set(o.unitTypeId, { ...prev, times: prev.times + 1, firstSlot: Math.min(prev.firstSlot, o.slot) });
    else map.set(o.unitTypeId, { o, times: 1, firstSlot: o.slot });
  }
  return [...map.values()]
    .sort((a, b) => a.firstSlot - b.firstSlot)
    .map(({ o, times, firstSlot }) => ({ unitTypeId: o.unitTypeId, displayName: o.displayName, affinity: o.affinity, abilityName: o.ability.displayName, times, firstSlot }));
}

export type RefugeeTimerState =
  /** Counting down to the next free menu; `msLeft` > 0. */
  | { readonly kind: "counting"; readonly msLeft: number; readonly mmss: string }
  /** The countdown since the last read has run out: re-read the menu (the server decides). */
  | { readonly kind: "stale" }
  /** The server says the next free menu is owed; the current menu is still claimable. */
  | { readonly kind: "due"; readonly claimed: boolean };

/** mm:ss (h:mm:ss past an hour), rounding UP so "0:00" never shows while time remains. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The timer as of `elapsedMs` after the view was read. */
export function refugeeTimer(view: RefugeeView, elapsedMs: number): RefugeeTimerState {
  if (view.timer.freeRefreshDue) return { kind: "due", claimed: view.menu.claimed !== null };
  const msLeft = view.timer.msUntilFreeRefresh - Math.max(0, elapsedMs);
  if (msLeft <= 0) return { kind: "stale" };
  return { kind: "counting", msLeft, mmss: formatCountdown(msLeft) };
}
