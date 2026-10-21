import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Note } from "./Note.tsx";

describe("Note", () => {
  it("renders paper by default with children", () => {
    const { container } = render(<Note>Body</Note>);
    const n = container.querySelector(".cv-note")!;
    expect(n).toHaveTextContent("Body");
    expect(n.className).not.toMatch(/cv-note--/);
  });
  it("applies variant and nail classes", () => {
    const { container } = render(<Note variant="canvas" nail="brass">x</Note>);
    expect(container.querySelector(".cv-note")).toHaveClass("cv-note--canvas", "cv-note--brass-nail");
    const { container: c2 } = render(<Note variant="shade">y</Note>);
    expect(c2.querySelector(".cv-note")).toHaveClass("cv-note--shade");
  });
  it("with a title is a named region and shows the title in .cv-label", () => {
    const { container } = render(<Note title="Orders">x</Note>);
    const r = screen.getByRole("region", { name: "Orders" });
    expect(r.tagName).toBe("SECTION");
    expect(r).toHaveClass("cv-note");
    expect(container.querySelector(".cv-label")).toHaveTextContent("Orders");
  });
});
