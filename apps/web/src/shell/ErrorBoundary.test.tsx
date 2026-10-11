import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { STRINGS } from "../strings.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

// Keeps throwing until the boundary has caught it once (React retries a throwing render
// synchronously in development before it hands the error to the boundary).
let armed = true;
function Bomb(): JSX.Element {
  if (armed) throw new TypeError("s?.webs.find is not a function");
  return <p data-testid="fine">Recovered</p>;
}

describe("ErrorBoundary", () => {
  it("renders the error UI with Retry instead of a blank page, and Retry re-mounts the children", async () => {
    const user = userEvent.setup();
    armed = true;
    const caught: unknown[] = [];
    const { container } = render(
      <ErrorBoundary
        onError={(e) => {
          caught.push(e);
          armed = false;
        }}
      >
        <Bomb />
      </ErrorBoundary>,
    );
    const err = await screen.findByTestId("api-error");
    expect(container).not.toBeEmptyDOMElement();
    expect(err).toHaveTextContent(STRINGS.app.renderError);
    expect(err).toHaveTextContent("render_error");
    expect(err).toHaveTextContent("TypeError: s?.webs.find is not a function");
    expect(caught).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: STRINGS.app.retry }));
    expect(await screen.findByTestId("fine")).toBeInTheDocument();
    expect(screen.queryByTestId("api-error")).not.toBeInTheDocument();
  });
});
