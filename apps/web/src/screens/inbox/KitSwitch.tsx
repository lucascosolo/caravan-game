import type { ReactNode } from "react";
import { STRINGS } from "../../strings.ts";

export interface KitSwitchProps {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: boolean) => void;
  readonly testId?: string;
}

/** The kit's leather-track switch (cv-switch) with its label; the On / Off word is on the track. */
export function KitSwitch({ label, checked, disabled = false, onChange, testId }: KitSwitchProps): JSX.Element {
  return (
    <label className="inbox__switch">
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} className="cv-switch" data-testid={testId} onClick={() => onChange(!checked)}>
        <span className="cv-switch__word">{checked ? STRINGS.privacy.on : STRINGS.privacy.off}</span>
        <span className="cv-switch__bolt" aria-hidden="true" />
      </button>
      <span>{label}</span>
    </label>
  );
}
