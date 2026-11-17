import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as authApi from "../../../lib/api/auth";
import { authQueryKeys } from "../../../lib/api/query-keys";
import { ApiTokensPanel } from "./ApiTokensPanel";

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><ApiTokensPanel /></QueryClientProvider>);
  return queryClient;
}

describe("ApiTokensPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a new secret once without putting it in the token query data", async () => {
    vi.spyOn(authApi, "getAuthTokens").mockResolvedValue({ ok: true, tokens: [] });
    const create = vi.spyOn(authApi, "createAuthToken").mockResolvedValue({ ok: true, id: 4, label: "Firmware", token: "secret-only-once" });
    const client = renderPanel();
    await waitFor(() => expect(screen.getByText("No API tokens have been created.")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Token label"), { target: { value: "Firmware" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("Firmware"));
    await waitFor(() => expect(screen.getByText("secret-only-once")).toBeInTheDocument());
    expect(client.getQueryData(authQueryKeys.tokens())).not.toHaveProperty("token");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("secret-only-once")).not.toBeInTheDocument();
  });
});
