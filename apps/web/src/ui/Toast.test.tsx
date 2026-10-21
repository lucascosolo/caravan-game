import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { STRINGS } from "../strings.ts";
import { Toast } from "./Toast.tsx";

describe("Toast", () => {
  it("info is a status toast with a visible title", () => {
    const { container } = render(<Toast title="Saved">Done</Toast>);
    expect(screen.getByRole("status")).toHaveClass("cv-toast");
    expect(screen.getByText("Saved")).toBeVisible();
    expect(container).toHaveTextContent("Done");
  });
  it("ok is also a status toast", () => {
    render(<Toast tone="ok">Fine</Toast>);
    expect(screen.getByRole("status")).toHaveClass("cv-toast");
  });
  it("error is an alert with a plate", () => {
    render(<Toast tone="error">Broke</Toast>);
    const a = screen.getByRole("alert");
    expect(a).toHaveClass("cv-error");
    expect(a.querySelector(".cv-error__plate")).not.toBeNull();
  });
  it("onDismiss adds a dismiss button", () => {
    const fn = vi.fn();
    render(<Toast onDismiss={fn}>x</Toast>);
    fireEvent.click(screen.getByRole("button", { name: STRINGS.ui.dismiss }));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
