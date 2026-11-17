import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminWorkspace } from "./AdminWorkspace";
import { adminApi } from "../../lib/api/admin";

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><AdminWorkspace /></QueryClientProvider>);
}

describe("AdminWorkspace", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders navigation from effective backend permissions", async () => {
    vi.spyOn(adminApi, "getPrincipal").mockResolvedValue({
      ok: true,
      user: { id: 1, name: "admin", username: "admin", email: "admin@example.test", role: "admin", groups: [], authenticated: true, permissions: ["settings:read", "users:read", "catalog:metadata:write"] },
    });

    renderWorkspace();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Administration" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Catalog" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tokens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Roles" })).not.toBeInTheDocument();
  });

  it("does not offer admin navigation to a principal without capabilities", async () => {
    vi.spyOn(adminApi, "getPrincipal").mockResolvedValue({
      ok: true,
      user: { id: 2, name: "reader", username: "reader", email: "reader@example.test", role: "user", groups: [], authenticated: true, permissions: [] },
    });

    renderWorkspace();
    await waitFor(() => expect(screen.getByRole("heading", { name: "No administrative permissions" })).toBeInTheDocument());
  });
});
