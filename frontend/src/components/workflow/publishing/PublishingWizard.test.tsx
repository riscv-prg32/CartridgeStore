import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as workflowApi from "../../../lib/api/workflow";
import { PublishingWizard } from "../PublishingWizard";

vi.mock("../../../lib/auth/config", () => ({ authIntegrationEnabled: true }));

const principal = { ok: true as const, user: { id: 7, name: "Developer", username: "developer", email: "developer@example.test", role: "publisher" as const, groups: [], authenticated: true, permissions: ["catalog:submit"] } };

function renderWizard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><PublishingWizard /></QueryClientProvider>);
}

describe("PublishingWizard", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test("preserves step navigation, architecture-neutral bundle selection and one multipart submission", async () => {
    const user = userEvent.setup();
    vi.spyOn(workflowApi, "getWorkflowPrincipal").mockResolvedValue(principal);
    const submit = vi.spyOn(workflowApi, "submitBundle").mockResolvedValue({ ok: true, status: "pending", review_required: true, submission_id: 4, id: 4, version: "1.0.0", submitted: [{ architecture: "qemu", file: "demo.prg32" }] });
    renderWizard();

    await user.click(await screen.findByRole("button", { name: "Choose bundle" }));
    const file = new File([new Uint8Array([80, 75, 3, 4])], "demo.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("Cartridge bundle"), { target: { files: [file] } });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Submit for review" }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith(file));
    expect(await screen.findByRole("heading", { name: "Submission received" })).toBeInTheDocument();
  });
});
