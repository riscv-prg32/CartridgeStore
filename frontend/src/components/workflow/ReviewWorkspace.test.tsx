import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkspace } from "./ReviewWorkspace";
import { approveSubmission, getSubmission, getWorkflowPrincipal, listSubmissions, rejectSubmission } from "../../lib/api/workflow";

vi.mock("../../lib/auth/config", () => ({ authIntegrationEnabled: true }));
vi.mock("../../lib/api/workflow", () => ({
  approveSubmission: vi.fn(),
  getSubmission: vi.fn(),
  getWorkflowPrincipal: vi.fn(),
  listSubmissions: vi.fn(),
  rejectSubmission: vi.fn(),
  workflowErrorMessage: () => "Workflow unavailable.",
}));

const pending = { id: 9, game_id: "org.example.demo", version: "1.0.0", status: "pending" as const, submitted_by_user_id: 7, submitted_by: "developer", reviewed_by_user_id: null, reviewed_by: null, pending_dir: "/disposable/pending/9", metadata_json: "{}", architectures_json: "[]", created_at: "2026-10-16", reviewed_at: null, metadata: { title: "Demo cartridge" }, architectures: [{ architecture: "qemu", filename: "demo.qemu" }], review_history: [] };
const detail = { ok: true as const, submission: pending };
const principal = { ok: true as const, user: { id: 1, name: "Reviewer", username: "reviewer", email: "reviewer@example.test", role: "editor" as const, groups: [], authenticated: true, permissions: ["submissions:read", "submissions:review", "submissions:reject"] } };

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><ReviewWorkspace /></QueryClientProvider>);
}

describe("ReviewWorkspace", () => {
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

  it("keeps review actions permission-scoped and submits supported metadata", async () => {
    vi.mocked(getWorkflowPrincipal).mockResolvedValue(principal);
    vi.mocked(listSubmissions).mockResolvedValue({ ok: true, submissions: [pending] });
    vi.mocked(getSubmission).mockResolvedValue(detail);
    vi.mocked(approveSubmission).mockResolvedValue(detail);
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole("button", { name: /#9 Demo cartridge/ }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    await user.click(screen.getByLabelText("title"));
    await user.clear(screen.getByLabelText("title"));
    await user.type(screen.getByLabelText("title"), "Approved demo");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(approveSubmission).toHaveBeenCalledWith(9, expect.objectContaining({ title: "Approved demo", tags: [] }), ""));
    await waitFor(() => expect(listSubmissions).toHaveBeenCalledTimes(2));
  });

  it("does not expose decision controls to a read-only reviewer", async () => {
    vi.mocked(getWorkflowPrincipal).mockResolvedValue({ ...principal, user: { ...principal.user, permissions: ["submissions:read"] } });
    vi.mocked(listSubmissions).mockResolvedValue({ ok: true, submissions: [pending] });
    vi.mocked(getSubmission).mockResolvedValue(detail);
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole("button", { name: /#9 Demo cartridge/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument());
    expect(rejectSubmission).not.toHaveBeenCalled();
  });
});
