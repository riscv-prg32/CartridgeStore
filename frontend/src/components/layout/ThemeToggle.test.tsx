import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeToggle } from "./ThemeToggle";
import { useThemeStore } from "../../stores/theme-store";

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useThemeStore.setState({ theme: "light" });
  });

  afterEach(() => {
    window.localStorage.clear();
    useThemeStore.setState({ theme: "light" });
  });

  it("exposes an accessible control and persists the selected theme", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const toggle = screen.getByRole("button", { name: "Switch to dark theme" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);

    expect(screen.getByRole("button", { name: "Switch to light theme" })).toHaveAttribute("aria-pressed", "true");
    expect(useThemeStore.getState().theme).toBe("dark");
    expect(window.localStorage.getItem("prg32-theme")).toBe("dark");
  });
});
