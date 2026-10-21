import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Pop } from "./Pop.tsx";

describe("Pop", () => {
  it("defaults the tail to bottom", () => {
    const { container } = render(<Pop>Hi</Pop>);
    expect(container.querySelector(".cv-pop")).toHaveClass("cv-pop--tail-bottom");
    expect(container).toHaveTextContent("Hi");
  });
  it("sets tail, --at, who and id", () => {
    const { container } = render(<Pop tail="left" at={30} who="Sheriff" id="p1">Howdy</Pop>);
    const p = container.querySelector(".cv-pop") as HTMLElement;
    expect(p).toHaveClass("cv-pop--tail-left");
    expect(p.style.getPropertyValue("--at")).toBe("30%");
    expect(p).toHaveAttribute("id", "p1");
    expect(container.querySelector(".cv-pop__who")).toHaveTextContent("Sheriff");
  });
});
