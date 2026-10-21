/** One kit icon (UI-SYSTEM §8.12): a pixel sprite, decorative; the meaning is always in a word beside it. */
export function Icon({ name, off = false, className }: { readonly name: string; readonly off?: boolean; readonly className?: string }): JSX.Element {
  return <i aria-hidden="true" className={`cv-art cv-ico-${name}${off ? "-off" : ""}${className ? ` ${className}` : ""}`} />;
}

export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
