import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "../../../lib/api/admin";
import { GroupsPanel } from "./GroupsPanel";

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><GroupsPanel /></QueryClientProvider>);
}

describe("GroupsPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps group query and create mutation in the groups feature boundary", async () => {
    vi.spyOn(adminApi, "listGroups").mockResolvedValue({ ok: true, groups: [{ id: 1, name: "editors", created_at: "2026-01-01T00:00:00Z", user_count: 2 }], limit: 100 });
    const create = vi.spyOn(adminApi, "createGroup").mockResolvedValue({ ok: true, group: { id: 2, name: "reviewers", created_at: "2026-01-01T00:00:00Z", user_count: 0 } });
    renderPanel();
    await waitFor(() => expect(screen.getByDisplayValue("editors")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("New group"), { target: { value: "reviewers" } });
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("reviewers"));
  });
});
