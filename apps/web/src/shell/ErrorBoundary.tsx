/**
 * The render error boundary (scaffold convention, QA-06 B1). Wraps the routed screens so a
 * throw during render never blanks the page: the player sees the same ErrorBox + Retry
 * every API failure uses, and Retry re-mounts the children from scratch. Nothing is
 * retried on the player's behalf and no state is kept across the reset: the screen under
 * it loads again as if freshly navigated to.
 *
 * Payload guards (src/api/shape.ts) are the first line, so a bad body is an ApiError long
 * before a render; this boundary is the backstop for everything else (a content lookup that
 * throws, a layout bug). Later screens are wrapped by App.tsx and need nothing of their own;
 * a screen that wants a narrower reset can nest another <ErrorBoundary>.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { ApiError } from "../api/client.ts";
import { STRINGS } from "../strings.ts";
import { ErrorBox } from "./ErrorBox.tsx";

export const RENDER_ERROR = "render_error";

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Called with the thrown value; the default logs it to the console. */
  readonly onError?: (error: unknown, info: ErrorInfo) => void;
}

interface State {
  readonly error: ApiError | null;
  readonly generation: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null, generation: 0 };

  static getDerivedStateFromError(thrown: unknown): Partial<State> {
    const text = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    return { error: new ApiError(0, RENDER_ERROR, STRINGS.app.renderError, text) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (this.props.onError) this.props.onError(error, info);
    else console.error("render error", error, info.componentStack);
  }

  private readonly reset = (): void => this.setState((s) => ({ error: null, generation: s.generation + 1 }));

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="shell">
          <main className="shell__main" data-testid="render-error">
            <ErrorBox error={this.state.error} heading={STRINGS.app.genericError} onRetry={this.reset} />
          </main>
        </div>
      );
    }
    // The key re-mounts the subtree on Retry so no stale state survives the reset.
    return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
  }
}
