import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Modal } from "./Modal.tsx";

/** An opener that disappears while the dialog is open, as a merged chip or a re-rendered list item does. */
function Harness({ fallback }: { readonly fallback: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [openerGone, setOpenerGone] = useState(false);
  return (
    <main>
      <h2 id="fallback" tabIndex={-1}>
        Board
      </h2>
      {!openerGone && (
        <button type="button" onClick={() => setOpen(true)}>
          opener
        </button>
      )}
      {open && (
        <Modal
          title="Confirm"
          busy={false}
          onCancel={() => setOpen(false)}
          {...(fallback ? { restoreFocusTo: () => document.getElementById("fallback") } : {})}
          actions={
            <button
              type="button"
              onClick={() => {
                setOpenerGone(true);
                setOpen(false);
              }}
            >
              done
            </button>
          }
        >
          <p>body</p>
        </Modal>
      )}
    </main>
  );
}

describe("Modal focus restore (QA-17 N4)", () => {
  it("returns focus to the opener when it is still there", async () => {
    const user = userEvent.setup();
    render(<Harness fallback />);
    await user.click(screen.getByRole("button", { name: "opener" }));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "opener" }));
  });

  it("falls back to restoreFocusTo when the opener is gone", async () => {
    const user = userEvent.setup();
    render(<Harness fallback />);
    await user.click(screen.getByRole("button", { name: "opener" }));
    await user.click(screen.getByRole("button", { name: "done" }));
    expect(document.activeElement).toBe(document.getElementById("fallback"));
  });

  it("without a fallback, focus lands on main rather than being lost to <body>", async () => {
    const user = userEvent.setup();
    render(<Harness fallback={false} />);
    await user.click(screen.getByRole("button", { name: "opener" }));
    await user.click(screen.getByRole("button", { name: "done" }));
    expect(document.activeElement?.tagName).toBe("MAIN");
  });
});
