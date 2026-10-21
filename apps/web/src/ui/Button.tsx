/**
 * Kit buttons (UI-SYSTEM §8.2): the brass swallowtail banner (`primary`, one per screen) and pills.
 * A disabled button always shows its reason in a pop-up under it (GUARDRAILS §4).
 * `hold` makes it a hold-to-commit (§8.2.4): pointer or Enter / Space held for the duration (600 ms by
 * default) fills six steps and then fires; releasing early sends nothing. A click that did not complete a hold
 * (a short tap, a screen reader's activation) opens a confirm row in place instead: the accessible tap path.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { STRINGS } from "../strings.ts";
import { Icon, cx } from "./Icon.tsx";

const STEPS = 6;

export interface ButtonProps {
  readonly variant?: "primary" | "secondary" | "tertiary" | "danger" | "leather";
  readonly block?: boolean;
  readonly icon?: string;
  readonly disabled?: boolean;
  readonly disabledReason?: ReactNode;
  readonly locked?: boolean;
  readonly busy?: boolean;
  readonly hold?: boolean | number;
  readonly className?: string;
  readonly testId?: string;
  readonly ariaLabel?: string;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}

export function Button({ variant = "secondary", block = false, icon, disabled = false, disabledReason, locked = false, busy = false, hold, className, testId, ariaLabel, onClick, children }: ButtonProps): JSX.Element {
  const reasonId = useId();
  const holdId = useId();
  const holdMs = hold === true ? 600 : typeof hold === "number" ? hold : 0;
  const [step, setStep] = useState(0);
  const [tap, setTap] = useState(false);
  const fired = useRef(false);
  const tapRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const latest = useRef(onClick);
  latest.current = onClick;
  const off = disabled || busy;

  const stop = (): void => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setStep(0);
  };
  const start = (): void => {
    if (off || timer.current) return;
    let n = 0;
    setStep(0);
    timer.current = setInterval(() => {
      n += 1;
      setStep(n);
      if (n >= STEPS) {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        fired.current = true;
        setTap(false);
        latest.current?.(); // the fill stays full (the stamp) until release

      }
    }, holdMs / STEPS);
  };
  useEffect(() => {
    if (tap) tapRef.current?.focus();
  }, [tap]);
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const isKey = (e: KeyboardEvent): boolean => e.key === "Enter" || e.key === " ";
  const holdProps = holdMs
    ? {
        "data-hold": String(step),
        onPointerDown: start,
        onPointerUp: stop,
        onPointerLeave: stop,
        onPointerCancel: stop,
        onKeyDown: (e: KeyboardEvent) => {
          if (!isKey(e)) return;
          e.preventDefault();
          if (!e.repeat) start();
        },
        onKeyUp: (e: KeyboardEvent) => {
          if (isKey(e)) stop();
        },
        onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
        onClick: () => {
          if (fired.current) fired.current = false;
          else setTap(true);
        },
      }
    : { onClick };
  const tapOpen = holdMs > 0 && tap && !off;
  const showReason = disabled && disabledReason !== undefined && disabledReason !== null;
  const describedBy = [showReason ? reasonId : null, holdMs ? holdId : null].filter(Boolean).join(" ") || undefined;
  const button = (
    <button
      type="button"
      className={cx("cv-btn", `cv-btn--${variant}`, block && "cv-btn--block", holdMs > 0 && "cv-btn--hold", step > 0 && "is-holding", disabled && "is-disabled", locked && "is-locked", !showReason && !tapOpen && className)}
      disabled={off}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      data-testid={testId}
      {...holdProps}
    >
      {icon && <Icon name={icon} off={disabled} />}
      <span>{children}</span>
      {holdMs > 0 && (
        <span id={holdId} className="cv-sr">
          {STRINGS.ui.hold}
        </span>
      )}
    </button>
  );
  const tapRow = tapOpen && (
    <div className="cv-pop cv-pop--tail-top cv-holdtap" role="group" aria-label={STRINGS.ui.holdTap}>
      <span className="cv-holdtap__line">{STRINGS.ui.holdTap}</span>
      <span className="cv-holdtap__row">
        <button type="button" className="cv-btn cv-btn--tertiary" onClick={() => setTap(false)} data-testid={testId && `${testId}-tap-cancel`}>
          <span>{STRINGS.ui.holdCancel}</span>
        </button>
        <button
          ref={tapRef}
          type="button"
          className="cv-btn cv-btn--secondary"
          onClick={() => {
            setTap(false);
            latest.current?.();
          }}
          data-testid={testId && `${testId}-tap`}
        >
          <span>{children}</span>
        </button>
      </span>
    </div>
  );
  if (!showReason && !tapRow) return button;
  return (
    <span className={cx("cv-btn-wrap", block && "cv-btn-wrap--block", className)}>
      {button}
      {showReason && (
        <span id={reasonId} className="cv-reason">
          {disabledReason}
        </span>
      )}
      {tapRow}
    </span>
  );
}

/** The one primary commit of a screen: the brass swallowtail, full width. */
export function CommitBanner(props: Omit<ButtonProps, "variant" | "block">): JSX.Element {
  return <Button {...props} variant="primary" block />;
}
