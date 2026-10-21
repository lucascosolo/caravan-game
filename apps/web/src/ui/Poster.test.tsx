import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Poster } from "./Poster.tsx";

describe("Poster", () => {
  it("renders the title as an h3 and all text parts", () => {
    const { container } = render(
      <Poster kicker="WANTED" title="Black Jack" flavour="Dead or alive" plaque="Level 4" bounty="500">
        <p>Extra</p>
      </Poster>,
    );
    expect(container.querySelector(".cv-poster")).not.toBeNull();
    const h = screen.getByRole("heading", { level: 3, name: "Black Jack" });
    expect(h).toHaveClass("cv-poster__title");
    for (const t of ["WANTED", "Dead or alive", "Level 4", "500", "Extra"]) expect(screen.getByText(t)).toBeVisible();
  });
});
