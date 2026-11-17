import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as authApi from "../../../lib/api/auth";
import { PasswordSecurityPanel } from "./PasswordSecurityPanel";

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><PasswordSecurityPanel /></QueryClientProvider>);
}

describe("PasswordSecurityPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps password values local and resets them after a successful change", async () => {
    const change = vi.spyOn(authApi, "changePassword").mockResolvedValue({ ok: true, message: "changed" });
    renderPanel();
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-secret" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-secret" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(change).toHaveBeenCalledWith("old-secret", "new-secret", "new-secret"));
    await waitFor(() => expect(screen.getByLabelText("Current password")).toHaveValue(""));
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByText("Password changed and other sessions were signed out.")).toBeInTheDocument();
  });
});
