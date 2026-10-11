/**
 * The one error presentation (scaffold convention, QA-06 B1): a screen shows an `ApiError`
 * through this and offers a Retry beside it. Status 0 is worded for the player (`network`
 * → "could not reach", `bad_payload` → "could not read"); any real status shows the
 * server's exact message. The code line carries `<status> <code>` and, when present, the
 * developer-facing `detail` (a payload path, a thrown error's text).
 */
import { ApiError, BAD_PAYLOAD, NETWORK } from "../api/client.ts";
import { STRINGS } from "../strings.ts";

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
    <div className="error" role="alert" data-testid="api-error">
      {heading && <div>{heading}</div>}
      <div data-testid="api-error-message">{playerMessage(error)}</div>
      <div className="error__code">
        {error.status > 0 ? `${error.status} ` : ""}
        {error.code}
        {error.detail ? <span className="error__detail"> · {error.detail}</span> : null}
      </div>
      {onRetry && (
        <button type="button" className="btn btn--block" style={{ marginTop: 8 }} onClick={onRetry}>
          {STRINGS.app.retry}
        </button>
      )}
    </div>
  );
}
