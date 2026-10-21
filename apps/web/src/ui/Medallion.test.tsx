import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Medallion } from "./Medallion.tsx";

describe("Medallion", () => {
  it("is a button named by its label with size and material classes", () => {
    render(<Medallion label="Map" icon="map" size="lg" material="brass" onClick={() => {}} />);
    const b = screen.getByRole("button", { name: "Map" });
    expect(b).toHaveAttribute("type", "button");
    expect(b).toHaveClass("cv-medal", "cv-medal--lg", "cv-medal--brass");
  });
  it("reflects pressed state", () => {
    render(<Medallion label="Map" icon="map" pressed onClick={() => {}} />);
    const b = screen.getByRole("button", { name: "Map" });
    expect(b).toHaveAttribute("aria-pressed", "true");
    expect(b).toHaveClass("is-on");
  });
  it("shows a badge and a caption", () => {
    const { container } = render(<Medallion label="Map" icon="map" badge={3} caption="Trail" onClick={() => {}} />);
    expect(container.querySelector(".cv-badge")).toHaveTextContent("3");
    expect(container.querySelector(".cv-medlab")).not.toBeNull();
    expect(container.querySelector(".cv-medlab__word")).toHaveTextContent("Trail");
  });
  it("fires onClick when enabled", () => {
    const fn = vi.fn();
    render(<Medallion label="Map" icon="map" onClick={fn} />);
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("disabled with a reason is inert and explains itself", () => {
    const fn = vi.fn();
    const { container } = render(<Medallion label="Map" icon="map" disabled disabledReason="Not yet" onClick={fn} />);
    const b = screen.getByRole("button", { name: "Map" });
    expect(b).toBeDisabled();
    fireEvent.click(b);
    expect(fn).not.toHaveBeenCalled();
    const reason = container.querySelector(".cv-reason")!;
    expect(reason).toHaveTextContent("Not yet");
    expect(b.getAttribute("aria-describedby")!.split(" ")).toContain(reason.id);
  });
});
