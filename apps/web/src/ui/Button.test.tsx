import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRINGS } from "../strings.ts";
import { Button, CommitBanner } from "./Button.tsx";

describe("Button", () => {
  it("defaults to secondary and fires onClick", () => {
    const fn = vi.fn();
    render(<Button onClick={fn}>Go</Button>);
    const b = screen.getByRole("button", { name: /Go/ });
    expect(b).toHaveAttribute("type", "button");
    expect(b).toHaveClass("cv-btn", "cv-btn--secondary");
    fireEvent.click(b);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("applies variant and block", () => {
    render(<Button variant="danger" block onClick={() => {}}>Burn</Button>);
    expect(screen.getByRole("button")).toHaveClass("cv-btn--danger", "cv-btn--block");
  });
  it("CommitBanner is primary and block", () => {
    render(<CommitBanner onClick={() => {}}>Commit</CommitBanner>);
    expect(screen.getByRole("button")).toHaveClass("cv-btn--primary", "cv-btn--block");
  });
  it("disabled with a reason shows and links it", () => {
    const fn = vi.fn();
    const { container } = render(<Button disabled disabledReason="Need 5 Coin" onClick={fn}>Buy</Button>);
    const b = screen.getByRole("button");
    expect(b).toBeDisabled();
    fireEvent.click(b);
    expect(fn).not.toHaveBeenCalled();
    const r = container.querySelector(".cv-reason")!;
    expect(r).toHaveTextContent("Need 5 Coin");
    expect(b.getAttribute("aria-describedby")!.split(" ")).toContain(r.id);
  });
  it("busy is aria-busy and disabled", () => {
    render(<Button busy onClick={() => {}}>Wait</Button>);
    const b = screen.getByRole("button");
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(b).toBeDisabled();
  });
});

describe("Button hold", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("has the hold class, mentions the hold hint, and ignores a plain click", () => {
    const fn = vi.fn();
    render(<Button hold onClick={fn}>Sell</Button>);
    const b = screen.getByRole("button");
    expect(b).toHaveClass("cv-btn--hold");
    expect(b.textContent + (b.getAttribute("aria-label") ?? "") + (b.getAttribute("aria-describedby") ? document.getElementById(b.getAttribute("aria-describedby")!)?.textContent : "")).toContain(STRINGS.ui.hold);
    fireEvent.click(b);
    expect(fn).not.toHaveBeenCalled();
  });
  it("fires once after the default 600 ms and steps data-hold 1..6", () => {
    const fn = vi.fn();
    render(<Button hold onClick={fn}>Sell</Button>);
    const b = screen.getByRole("button");
    fireEvent.pointerDown(b);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      act(() => { vi.advanceTimersByTime(50); });
      seen.add(b.getAttribute("data-hold")!);
    }
    for (const s of ["1", "2", "3", "4", "5", "6"]) expect(seen.has(s)).toBe(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("a numeric hold uses that duration", () => {
    const fn = vi.fn();
    render(<Button hold={1000} onClick={fn}>Sell</Button>);
    const b = screen.getByRole("button");
    fireEvent.pointerDown(b);
    act(() => { vi.advanceTimersByTime(700); });
    expect(fn).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(400); });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("releasing early cancels and resets data-hold", () => {
    const fn = vi.fn();
    render(<Button hold onClick={fn}>Sell</Button>);
    const b = screen.getByRole("button");
    fireEvent.pointerDown(b);
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.pointerUp(b);
    expect(b).toHaveAttribute("data-hold", "0");
    act(() => { vi.advanceTimersByTime(2000); });
    expect(fn).not.toHaveBeenCalled();
  });
  it("keyboard Enter or Space held past the duration fires; early keyUp cancels", () => {
    const fn = vi.fn();
    render(<Button hold onClick={fn}>Sell</Button>);
    const b = screen.getByRole("button");
    fireEvent.keyDown(b, { key: "Enter" });
    act(() => { vi.advanceTimersByTime(700); });
    fireEvent.keyUp(b, { key: "Enter" });
    expect(fn).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(b, { key: " " });
    act(() => { vi.advanceTimersByTime(700); });
    fireEvent.keyUp(b, { key: " " });
    expect(fn).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(b, { key: "Enter" });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.keyUp(b, { key: "Enter" });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a plain click opens an in-place confirm row; its confirm calls onClick once and closes it", () => {
    const fn = vi.fn();
    render(<Button hold testId="sell" onClick={fn}>Sell</Button>);
    expect(screen.queryByRole("group")).toBeNull();
    fireEvent.click(screen.getByTestId("sell"));
    expect(fn).not.toHaveBeenCalled();
    const row = screen.getByRole("group", { name: STRINGS.ui.holdTap });
    expect(within(row).getByTestId("sell-tap-cancel")).toHaveTextContent(STRINGS.ui.holdCancel);
    expect(within(row).getByTestId("sell-tap")).toHaveTextContent("Sell");
    expect(screen.getByTestId("sell-tap")).toHaveFocus();
    fireEvent.click(screen.getByTestId("sell-tap"));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group")).toBeNull();
  });
  it("cancel closes the confirm row without firing", () => {
    const fn = vi.fn();
    render(<Button hold testId="sell" onClick={fn}>Sell</Button>);
    fireEvent.click(screen.getByTestId("sell"));
    fireEvent.click(screen.getByTestId("sell-tap-cancel"));
    expect(screen.queryByRole("group")).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
  it("the click after a completed pointer hold fires once and does not open the row", () => {
    const fn = vi.fn();
    render(<Button hold testId="sell" onClick={fn}>Sell</Button>);
    const b = screen.getByTestId("sell");
    fireEvent.pointerDown(b);
    act(() => { vi.advanceTimersByTime(700); });
    expect(fn).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(b);
    fireEvent.click(b);
    expect(screen.queryByRole("group")).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("disabled and busy hold buttons never show the confirm row", () => {
    const fn = vi.fn();
    const { rerender } = render(<Button hold disabled testId="sell" onClick={fn}>Sell</Button>);
    fireEvent.click(screen.getByTestId("sell"));
    expect(screen.queryByRole("group")).toBeNull();
    rerender(<Button hold busy testId="sell" onClick={fn}>Sell</Button>);
    fireEvent.click(screen.getByTestId("sell"));
    expect(screen.queryByRole("group")).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
  it("an open confirm row closes when the button becomes disabled", () => {
    const fn = vi.fn();
    const { rerender } = render(<Button hold testId="sell" onClick={fn}>Sell</Button>);
    fireEvent.click(screen.getByTestId("sell"));
    expect(screen.getByRole("group")).toBeInTheDocument();
    rerender(<Button hold busy testId="sell" onClick={fn}>Sell</Button>);
    expect(screen.queryByRole("group")).toBeNull();
  });
});
