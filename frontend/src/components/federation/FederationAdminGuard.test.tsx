import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FederationAdminGuard } from "./FederationAdminGuard";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/federation", useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("../../lib/auth/config", () => ({ authIntegrationEnabled: true }));

function renderGuard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><FederationAdminGuard><p>private federation area</p></FederationAdminGuard></QueryClientProvider>);
}

describe("FederationAdminGuard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/me")) return Promise.resolve(new Response(JSON.stringify({ ok: true, user: { id: 1, name: "Admin", username: "admin", email: "admin@example.test", role: "admin", groups: [], authenticated: true, permissions: ["federation:read"] } }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ ok: false, error: "unexpected" }), { status: 500 }));
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  test("does not expose private children when permission is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, user: { id: 1, name: "Reader", username: "reader", email: "reader@example.test", role: "reader", groups: [], authenticated: true, permissions: [] } }), { status: 200 }))));
    renderGuard();
    expect(await screen.findByRole("heading", { name: "Federation administration is not available" })).toBeInTheDocument();
    expect(screen.queryByText("private federation area")).not.toBeInTheDocument();
  });
});
