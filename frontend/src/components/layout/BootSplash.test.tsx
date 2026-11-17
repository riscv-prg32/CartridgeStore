import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BootSplash } from "./BootSplash";

describe("BootSplash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the boot screen until it completes automatically", () => {
    render(<BootSplash />);
    act(() => vi.advanceTimersByTime(0));

    expect(
      screen.getByRole("status", {
        name: "Starting PRG32 Cartridge Store",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "PRG32 retro gaming and coding",
      }),
    ).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(760));
    act(() => vi.advanceTimersByTime(240));

    expect(
      screen.queryByRole("status", {
        name: "Starting PRG32 Cartridge Store",
      }),
    ).not.toBeInTheDocument();
  });

  it("replays when the document mounts again after a refresh", () => {
    const firstMount = render(<BootSplash />);
    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.getByRole("status", {
        name: "Starting PRG32 Cartridge Store",
      }),
    ).toBeInTheDocument();

    firstMount.unmount();
    render(<BootSplash />);
    act(() => vi.advanceTimersByTime(1));

    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
