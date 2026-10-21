/**
 * The modal behaviour shared by Modal and the kit's Sheet (extracted from Modal, C4a): every other body
 * child is `inert` while open; Tab / Shift+Tab cycle inside; Escape cancels unless busy; focus lands on
 * the first focusable control and returns to the opener on close, or to `restoreFocusTo`, then `main`.
 */
import { useEffect, type MutableRefObject, type RefObject } from "react";

export const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalLatest {
  busy: boolean;
  onCancel: () => void;
  restoreFocusTo?: (() => HTMLElement | null) | undefined;
}

export function useModalFocus(ref: RefObject<HTMLElement>, latest: MutableRefObject<ModalLatest>): void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    const host = dialog?.parentElement ?? null;
    const made: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || el.tagName === "SCRIPT" || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      made.push(el);
    }
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!latest.current.busy) latest.current.onCancel();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = dialog.contains(active);
      if (e.shiftKey && (active === firstEl || !inside)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !inside)) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      for (const el of made) el.removeAttribute("inert");
      if (opener?.isConnected) {
        opener.focus();
        return;
      }
      const fallback = latest.current.restoreFocusTo?.() ?? document.querySelector<HTMLElement>("main");
      if (fallback) {
        if (!fallback.matches(FOCUSABLE) && !fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
        fallback.focus();
      }
    };
  }, []);
}
