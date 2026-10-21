import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon.tsx";

describe("Icon", () => {
  it("renders a decorative art hook", () => {
    const { container } = render(<Icon name="coin" />);
    const i = container.querySelector("i")!;
    expect(i).toHaveClass("cv-art", "cv-ico-coin");
    expect(i).toHaveAttribute("aria-hidden", "true");
  });
  it("uses the -off class when off", () => {
    const { container } = render(<Icon name="coin" off />);
    expect(container.querySelector("i")).toHaveClass("cv-ico-coin-off");
  });
});
