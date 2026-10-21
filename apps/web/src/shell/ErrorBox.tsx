/**
 * The one error presentation (scaffold convention, QA-06 B1): a screen shows an `ApiError`
 * through this and offers a Retry beside it. Status 0 is worded for the player (`network`
 * → "could not reach", `bad_payload` → "could not read"); any real status shows the
 * server's exact message. The code line carries `<status> <code>` and, when present, the
 * developer-facing `detail` (a payload path, a thrown error's text).
 */
import { ApiError, BAD_PAYLOAD, NETWORK } from "../api/client.ts";
import { STRINGS } from "../strings.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";

export interface ErrorBoxProps {
  readonly error: ApiError;
  readonly heading?: string;
  /** Rendered as a Retry button under the message when given. */
  readonly onRetry?: () => void;
}

export function playerMessage(error: ApiError): string {
  if (error.status === 0 && error.code === NETWORK) return STRINGS.app.networkError;
  if (error.status === 0 && error.code === BAD_PAYLOAD) return STRINGS.app.badPayload;
  return error.message;
}

export function ErrorBox({ error, heading, onRetry }: ErrorBoxProps): JSX.Element {
  return (
    <div className="cv-error error" role="alert" data-testid="api-error">
      <span className="cv-error__plate">
        <Icon name="broken-wheel" />
      </span>
      <div className="cv-error__text">
        {heading && <b>{heading}</b>}
        <div data-testid="api-error-message">{playerMessage(error)}</div>
        <div className="error__code">
          {error.status > 0 ? `${error.status} ` : ""}
          {error.code}
          {error.detail ? <span className="error__detail"> · {error.detail}</span> : null}
        </div>
        {onRetry && (
          <Button onClick={onRetry} block>
            {STRINGS.app.retry}
          </Button>
        )}
      </div>
    </div>
  );
}
