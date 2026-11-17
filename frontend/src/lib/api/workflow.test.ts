import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  approveSubmission,
  clearWorkflowSessionState,
  getWorkflowPrincipal,
  listSubmissions,
  submitBundle,
  WorkflowIntegrationUnavailableError,
} from "./workflow";

const csrf = "csrf-token-that-is-long-enough-for-the-workflow-contract-123";
const submission = {
  id: 4,
  game_id: "demo",
  version: "1.0.0",
  status: "pending",
  submitted_by_user_id: 7,
  submitted_by: "developer",
  reviewed_by_user_id: null,
  reviewed_by: null,
  pending_dir: null,
  metadata_json: "{}",
  architectures_json: "[]",
  created_at: "2026-10-14T00:00:00Z",
  reviewed_at: null,
  metadata: { title: "Demo" },
  architectures: [{ architecture: "qemu" }],
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("workflow API integration", () => {
  beforeEach(() => {
    clearWorkflowSessionState();
    vi.restoreAllMocks();
  });

  it("uses the Fastify API and preserves the submission contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, user: { id: 7, name: "Developer", username: "developer", email: "developer@example.test", role: "publisher", groups: [], authenticated: true, permissions: ["catalog:submit"] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, submissions: [submission] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getWorkflowPrincipal()).resolves.toMatchObject({ ok: true });
    await expect(listSubmissions("pending")).resolves.toEqual({ ok: true, submissions: [submission] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/auth/me");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/submissions?status=pending");
  });

  it("fetches CSRF once for a bundle upload and sends multipart bytes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, csrf_token: csrf }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, status: "pending", review_required: true, submission_id: 4, id: 4, version: "1.0.0", submitted: [{ architecture: "qemu", file: "demo.prg32" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([80, 75, 3, 4])], "demo.zip", { type: "application/zip" });

    await expect(submitBundle(file)).resolves.toMatchObject({ status: "pending", submission_id: 4 });
    const init = fetchMock.mock.calls[1]?.[1];
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/publish/bundle");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-CSRFToken")).toBe(csrf);
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("bundle")).toBeInstanceOf(File);
  });

  it("uses CSRF for editor approval and does not retry a rejection", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, csrf_token: csrf }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: "editors group required" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(approveSubmission(4, { title: "Demo" })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/submissions/4/verify");
  });

  it("fails closed when the Fastify API is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>", { status: 404 })));
    await expect(getWorkflowPrincipal()).rejects.toBeInstanceOf(WorkflowIntegrationUnavailableError);
  });
});
