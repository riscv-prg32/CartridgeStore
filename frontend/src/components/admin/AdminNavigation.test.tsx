import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdminNavigation, ADMIN_NAV_ITEMS } from "./AdminNavigation";

describe("AdminNavigation", () => {
  it("renders only the permission-filtered sections and reports selection", () => {
    const onSelect = vi.fn();
    render(<AdminNavigation items={ADMIN_NAV_ITEMS.filter((item) => item.section === "settings" || item.section === "users")} selected="settings" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "Settings" })).toHaveClass("bg-[var(--color-primary)]");
    expect(screen.queryByRole("button", { name: "Tokens" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Users" }));
    expect(onSelect).toHaveBeenCalledWith("users");
  });
});
