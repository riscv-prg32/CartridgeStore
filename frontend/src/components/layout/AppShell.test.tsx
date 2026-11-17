import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";

const pathname = vi.hoisted(() => ({ value: "/explore" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.value,
}));

vi.mock("../auth/AuthNavigation", () => ({
  AuthNavigation: () => <a href="/login">Sign in</a>,
}));

vi.mock("./ThemeToggle", () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));

describe("AppShell", () => {
  beforeEach(() => {
    pathname.value = "/explore";
    vi.clearAllMocks();
  });

  it("exposes the canonical public navigation and an accessible mobile menu", async () => {
    const user = userEvent.setup();
    render(<AppShell><p>Page content</p></AppShell>);

    expect(screen.getByRole("banner")).toHaveClass("sticky", "top-0", "z-40");
    const primary = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(primary).toHaveTextContent("Explore");
    expect(primary).toHaveTextContent("Leaderboards");
    expect(primary).toHaveTextContent("Statistics");
    expect(primary).toHaveTextContent("Documentation");
    expect(within(primary).queryByRole("link", { name: "Search" })).not.toBeInTheDocument();
    expect(within(primary).getByRole("link", { name: "Explore" })).toHaveAttribute("href", "/explore");
    expect(within(primary).getByRole("link", { name: "Statistics" })).toHaveAttribute("href", "/stats");
    expect(within(primary).getByRole("link", { name: "Explore" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Administration" })).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "Open navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    expect(screen.getByRole("button", { name: "Close navigation", hidden: true })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "Mobile primary navigation" })).toBeInTheDocument();
    const mobile = screen.getByRole("navigation", { name: "Mobile primary navigation" });
    expect(within(mobile).getByRole("link", { name: "Leaderboards" })).toHaveAttribute("href", "/scores");
    expect(within(mobile).queryByRole("link", { name: "Search" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("navigation", { name: "Mobile primary navigation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
  });

  it("keeps the dashboard focused on its application workspace", () => {
    pathname.value = "/dashboard";

    render(<AppShell><p>Dashboard content</p></AppShell>);

    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });
});
