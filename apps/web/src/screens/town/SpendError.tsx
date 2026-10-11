/**
 * A spend that may or may not have landed (QA-17 S2). Status 0 on a POST that moves Coin
 * or the roster (recruit, reroll, claim, refresh) means the request may have committed and
 * only the answer was lost, so the generic ErrorBox wording ("Nothing was changed") would
 * be a lie. This box says "could not confirm" instead and, while the dialog that sent it is
 * still open, its caller offers "Try again", which replays the SAME request (the same
 * `requestId` / `sequence`), which the server answers with the stored outcome if the first
 * attempt landed: never a second charge.
 *
 * A real status is a real refusal; it is shown through the ordinary ErrorBox (the server's
 * own message), since then nothing moved.
 */
import { ApiError, BAD_PAYLOAD } from "../../api/client.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.town;

/** True when the POST may have committed: no usable answer came back. */
export const unconfirmed = (error: ApiError): boolean => error.status === 0;

export function SpendError({ error, heading }: { readonly error: ApiError; readonly heading: string }): JSX.Element {
  if (!unconfirmed(error)) return <ErrorBox error={error} heading={heading} />;
  return (
    <div className="error" role="alert" data-testid="spend-unconfirmed">
      <div>{T.spendUnconfirmed}</div>
      <div data-testid="api-error-message">{error.code === BAD_PAYLOAD ? T.spendUnreadable : T.spendUnconfirmedLoad}</div>
      <div>{T.spendUnconfirmedBody}</div>
      <div className="error__code">
        {error.code}
        {error.detail ? <span className="error__detail"> · {error.detail}</span> : null}
      </div>
    </div>
  );
}
