import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as authApi from "../../lib/api/auth";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { AccountWorkspace } from "./AccountWorkspace";

vi.mock("../../lib/auth/use-current-user", () => ({ useCurrentUser: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><AccountWorkspace /></QueryClientProvider>);
}

describe("AccountWorkspace", () => {
  afterEach(() => vi.restoreAllMocks());

  it("composes the account security features from the authoritative current user", () => {
    vi.mocked(useCurrentUser).mockReturnValue({ isPending: false, error: null, user: { id: 7, name: "Ada", username: "ada", email: "ada@example.test", role: "user", groups: [], authenticated: true, permissions: [] } } as unknown as ReturnType<typeof useCurrentUser>);
    vi.spyOn(authApi, "getAuthTokens").mockResolvedValue({ ok: true, tokens: [] });
    vi.spyOn(authApi, "getPasskeys").mockResolvedValue({ ok: true, credentials: [] });
    renderWorkspace();
    expect(screen.getByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(screen.getByText(/ada@example\.test/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Password" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "API tokens" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Passkeys" })).toBeInTheDocument();
  });

  it("keeps anonymous state out of account feature composition", () => {
    vi.mocked(useCurrentUser).mockReturnValue({ isPending: false, error: null, user: null } as unknown as ReturnType<typeof useCurrentUser>);
    renderWorkspace();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "API tokens" })).not.toBeInTheDocument();
  });
});
