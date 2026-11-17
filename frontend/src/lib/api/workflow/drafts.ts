import { withCsrfToken } from "../client";
import type {
  DraftListResponse,
  DraftResponse,
  WorkflowSubmissionResult,
} from "../contracts";
import {
  draftListResponseSchema,
  draftResponseSchema,
  workflowSubmissionResultSchema,
} from "../schemas";
import { workflowCsrf, workflowRequest } from "./transport";

/** Lists creator drafts. */
export function listDrafts(): Promise<DraftListResponse> {
  return workflowRequest("/api/drafts", undefined, draftListResponseSchema);
}

/** Creates a draft with optional initial metadata. */
export async function createDraft(
  metadata: Record<string, unknown> = {},
): Promise<DraftResponse> {
  return workflowRequest(
    "/api/drafts",
    {
      method: "POST",
      headers: withCsrfToken(await workflowCsrf(), {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ metadata }),
    },
    draftResponseSchema,
  );
}

/** Updates draft metadata. */
export async function updateDraft(
  id: string,
  metadata: Record<string, unknown>,
): Promise<DraftResponse> {
  return workflowRequest(
    `/api/drafts/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: withCsrfToken(await workflowCsrf(), {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ metadata }),
    },
    draftResponseSchema,
  );
}

/** Deletes a draft. */
export async function deleteDraft(id: string): Promise<{ ok: true }> {
  return workflowRequest(`/api/drafts/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: withCsrfToken(await workflowCsrf()),
  });
}

/** Attaches a cartridge bundle to a draft. */
export async function attachDraftArtifact(
  id: string,
  file: File,
): Promise<DraftResponse> {
  const form = new FormData();
  form.set("bundle", file, file.name);
  return workflowRequest(
    `/api/drafts/${encodeURIComponent(id)}/artifact`,
    {
      method: "POST",
      headers: withCsrfToken(await workflowCsrf()),
      body: form,
    },
    draftResponseSchema,
  );
}

/** Submits a draft for review. */
export async function submitDraft(
  id: string,
): Promise<WorkflowSubmissionResult> {
  return workflowRequest(
    `/api/drafts/${encodeURIComponent(id)}/submit`,
    {
      method: "POST",
      headers: withCsrfToken(await workflowCsrf()),
    },
    workflowSubmissionResultSchema,
  );
}
