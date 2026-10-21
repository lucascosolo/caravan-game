/**
 * Lets a screen hang its own resource chips (Coin, vault, timers) on the shell's HUD rope (C4a).
 * The shell renders <HudSlot/> inside its ChipStrap; a screen renders <HudPortal>…chips…</HudPortal>.
 * Without a mounted slot (a screen rendered alone, as in tests) the chips render in place.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const SlotContext = createContext<HTMLElement | null>(null);

export function HudSlotProvider({ children }: { readonly children: (setSlot: (el: HTMLElement | null) => void) => ReactNode }): JSX.Element {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return <SlotContext.Provider value={slot}>{children(setSlot)}</SlotContext.Provider>;
}

export function HudPortal({ children }: { readonly children: ReactNode }): JSX.Element {
  const slot = useContext(SlotContext);
  return slot ? createPortal(children, slot) : <>{children}</>;
}
