import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import { ThemeToggle } from "../components/layout/ThemeToggle";
import { ThemeProvider } from "./ThemeProvider";
import { useThemeStore } from "../stores/theme-store";

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useThemeStore.setState({ theme: "dark" });
  });

  test("hydrates a stored preference after the deterministic dark first render", async () => {
    window.localStorage.setItem("prg32-theme", "light");

    render(<ThemeProvider><ThemeToggle /></ThemeProvider>);

    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument());
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement).not.toHaveClass("dark");
  });
});
