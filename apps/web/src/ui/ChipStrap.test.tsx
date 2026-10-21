import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STRINGS } from "../strings.ts";
import { Chip, ChipStrap } from "./ChipStrap.tsx";

describe("ChipStrap", () => {
  it("is a labelled header, default label from strings", () => {
    const { container } = render(<ChipStrap><span>a</span></ChipStrap>);
    expect(container.querySelector("header.cv-hud")).toHaveAttribute("aria-label", STRINGS.ui.resources);
  });
  it("uses a custom label and renders end content after the spacer", () => {
    const { container } = render(<ChipStrap label="Funds" end={<b>END</b>}><span>a</span></ChipStrap>);
    const h = container.querySelector("header.cv-hud")!;
    expect(h).toHaveAttribute("aria-label", "Funds");
    const spacer = h.querySelector(".cv-hud__spacer")!;
    expect(spacer.compareDocumentPosition(screen.getByText("END")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Chip", () => {
  it("disc has no modifier; value in .cv-num; label findable; caption shown", () => {
    const { container } = render(<Chip icon="coin" label="Coin" value="120" caption="of 500" />);
    const c = container.querySelector(".cv-chip")!;
    expect(c.className).not.toMatch(/cv-chip--/);
    expect(c.querySelector(".cv-num")).toHaveTextContent("120");
    expect(c.querySelector(".cv-chip__cap")).toHaveTextContent("of 500");
    expect(screen.getByText("Coin")).toBeInTheDocument();
    expect(c.textContent).toContain("Coin");
    expect(c.textContent).toContain("120");
  });
  it("kind adds a modifier", () => {
    const { container } = render(<Chip kind="purse" icon="coin" label="Purse" value="1" />);
    expect(container.querySelector(".cv-chip")).toHaveClass("cv-chip--purse");
  });
});
