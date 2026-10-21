import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sign } from "./Sign.tsx";

describe("Sign", () => {
  it("with onClick is a button; chain has no modifier", () => {
    const fn = vi.fn();
    render(<Sign onClick={fn}>Ride out</Sign>);
    const b = screen.getByRole("button", { name: /Ride out/ });
    expect(b).toHaveAttribute("type", "button");
    expect(b).toHaveClass("cv-sign");
    expect(b.className).not.toMatch(/cv-sign--/);
    fireEvent.click(b);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("applies the variant class", () => {
    render(<Sign variant="rope" onClick={() => {}}>Go</Sign>);
    expect(screen.getByRole("button")).toHaveClass("cv-sign--rope");
  });
  it("without onClick is a non-interactive span", () => {
    const { container } = render(<Sign>Plain</Sign>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("span.cv-sign")).toHaveTextContent("Plain");
  });
  it("badge shows the number and badgeLabel joins the name", () => {
    const { container } = render(<Sign onClick={() => {}} badge={2} badgeLabel="new items">Stock</Sign>);
    expect(container.querySelector(".cv-badge")).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /Stock/ })).toHaveAccessibleName(/new items/);
  });
});
