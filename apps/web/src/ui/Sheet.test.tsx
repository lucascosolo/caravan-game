import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { STRINGS } from "../strings.ts";
import { Sheet } from "./Sheet.tsx";

describe("Sheet", () => {
  it("is a modal dialog named by its title, portalled to body", () => {
    const { container } = render(<Sheet title="Wagon" onClose={() => {}}>Body</Sheet>);
    const d = screen.getByRole("dialog", { name: "Wagon" });
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(container.contains(d)).toBe(false);
    expect(document.body.contains(d)).toBe(true);
  });
  it("default detent is half; the title and kicker sit in the head", () => {
    render(<Sheet title="Wagon" kicker="Camp" onClose={() => {}}>x</Sheet>);
    const d = screen.getByRole("dialog");
    expect(d).toHaveAttribute("data-detent", "half");
    expect(d).toHaveClass("cv-sheet--half");
    expect(d.querySelector(".cv-sheet__head .cv-title")).toHaveTextContent("Wagon");
    expect(d.querySelector(".cv-sheet__kicker")).toHaveTextContent("Camp");
  });
  it("a question puts the title on the awning", () => {
    render(<Sheet title="Sell?" question onClose={() => {}}>x</Sheet>);
    expect(screen.getByRole("dialog").querySelector(".cv-sheet__awning .cv-title")).toHaveTextContent("Sell?");
  });
  it("grip cycles peek, half, full, peek", () => {
    render(<Sheet title="T" detent="peek" onClose={() => {}}>x</Sheet>);
    const d = screen.getByRole("dialog");
    const grip = screen.getByRole("button", { name: STRINGS.ui.resize });
    expect(d).toHaveAttribute("data-detent", "peek");
    const seq: string[] = [];
    for (let i = 0; i < 3; i++) {
      fireEvent.click(grip);
      seq.push(d.getAttribute("data-detent")!);
    }
    expect(seq).toEqual(["half", "full", "peek"]);
    expect(d).toHaveClass("cv-sheet--peek");
  });
  it("close button and Escape call onClose; Escape is ignored when busy", () => {
    const fn = vi.fn();
    const { rerender } = render(<Sheet title="T" onClose={fn}>x</Sheet>);
    fireEvent.click(screen.getByRole("button", { name: STRINGS.ui.close }));
    expect(fn).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(fn).toHaveBeenCalledTimes(2);
    rerender(<Sheet title="T" busy onClose={fn}>x</Sheet>);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("renders the footer and moves focus inside", () => {
    render(<Sheet title="T" footer={<button type="button">Done</button>} onClose={() => {}}>x</Sheet>);
    const d = screen.getByRole("dialog");
    expect(d.querySelector(".cv-sheet__foot")).toHaveTextContent("Done");
    expect(d.contains(document.activeElement)).toBe(true);
  });
});
