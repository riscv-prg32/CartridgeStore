import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreatorWorkspace } from "./creator/CreatorWorkspace";
import { getWorkflowPrincipal, listMySubmissions } from "../../lib/api/workflow";

vi.mock("../../lib/auth/config", () => ({ authIntegrationEnabled: true }));
vi.mock("../../lib/api/workflow", () => ({
  getWorkflowPrincipal: vi.fn(),
  listMySubmissions: vi.fn(),
  resubmitSubmission: vi.fn(),
  workflowErrorMessage: () => "Workflow unavailable."
}));

const principal = { ok: true as const, user: { id: 7, name: "Developer", username: "developer", email: "developer@example.test", role: "publisher" as const, groups: [], authenticated: true, permissions: ["catalog:submit"] } };
const pagination = { page: 1, per_page: 25, total: 1, pages: 1, has_next: false, has_prev: false, next_page: null, prev_page: null };

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><CreatorWorkspace /></QueryClientProvider>);
}

describe("DeveloperWorkspace ownership view", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders the authenticated user's real submissions and statuses", async () => {
    vi.mocked(getWorkflowPrincipal).mockResolvedValue(principal);
    vi.mocked(listMySubmissions).mockResolvedValue({ ok: true, pagination: { ...pagination, total: 3 }, submissions: [
      { id: 3, game_id: "org.example.demo", title: "Demo", version: "1.0.0", status: "pending", created_at: "2026-10-14", reviewed_at: null },
      { id: 2, game_id: "org.example.verified", title: "Verified Demo", version: "1.0.0", status: "verified", created_at: "2026-10-13", reviewed_at: "2026-10-14" },
      { id: 1, game_id: "org.example.rejected", title: "Rejected Demo", version: "1.0.0", status: "rejected", created_at: "2026-10-12", reviewed_at: "2026-10-13" },
    ] });
    renderWorkspace();
    await waitFor(() => expect(screen.getByRole("heading", { name: "My submissions" })).toBeInTheDocument());
    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getByText("Pending review")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(listMySubmissions).toHaveBeenCalledWith(undefined, 1, 25);
  });

  it("renders the empty ownership state without inventing records", async () => {
    vi.mocked(getWorkflowPrincipal).mockResolvedValue(principal);
    vi.mocked(listMySubmissions).mockResolvedValue({ ok: true, pagination: { ...pagination, total: 0 }, submissions: [] });
    renderWorkspace();
    await waitFor(() => expect(screen.getByText("You have no submissions yet.")).toBeInTheDocument());
    expect(screen.queryByText("Pending review")).not.toBeInTheDocument();
  });
});
