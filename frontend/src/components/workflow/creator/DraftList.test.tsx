import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as workflowApi from "../../../lib/api/workflow";
import { DraftList } from "./DraftList";

const draft = { id: "draft-1", status: "draft" as const, metadata: {}, has_artifact: false, source_submission_id: null, submitted_submission_id: null, created_at: "2026-10-16", updated_at: "2026-10-16", submitted_at: null };

function renderDraftList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><DraftList /></QueryClientProvider>);
}

describe("DraftList", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test("keeps draft artifact attachment as a multipart-owned workflow operation", async () => {
    vi.spyOn(workflowApi, "listDrafts").mockResolvedValue({ ok: true, drafts: [draft] });
    const attach = vi.spyOn(workflowApi, "attachDraftArtifact").mockResolvedValue({ ok: true, draft: { ...draft, has_artifact: true } });
    renderDraftList();

    const file = new File([new Uint8Array([80, 75, 3, 4])], "demo.zip", { type: "application/zip" });
    await screen.findByText("draft-1 · draft · bundle missing");
    fireEvent.change(screen.getByLabelText("Attach ZIP to draft draft-1"), { target: { files: [file] } });

    await waitFor(() => expect(attach).toHaveBeenCalledWith("draft-1", file));
  });
});
