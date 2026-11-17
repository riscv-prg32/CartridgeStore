import type {
  DraftResponse,
  OwnedSubmissionListResponse,
  WorkflowSubmissionListResponse,
  WorkflowSubmissionResponse,
} from "../contracts";
import {
  draftResponseSchema,
  ownedSubmissionListResponseSchema,
  workflowSubmissionListResponseSchema,
  workflowSubmissionResponseSchema,
} from "../schemas";
import { withCsrfToken } from "../client";
import { workflowCsrf, workflowRequest } from "./transport";

/** Lists submissions visible to reviewers. */
export function listSubmissions(
  status?: string,
): Promise<WorkflowSubmissionListResponse> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return workflowRequest(
    `/api/submissions${query}`,
    undefined,
    workflowSubmissionListResponseSchema,
  );
}

/** Reads one submission by numeric identifier. */
export function getSubmission(
  id: number,
): Promise<WorkflowSubmissionResponse> {
  return workflowRequest(
    `/api/submissions/${id}`,
    undefined,
    workflowSubmissionResponseSchema,
  );
}

/** Lists submissions owned by the current creator. */
export function listMySubmissions(
  status?: string,
  page?: number,
  perPage?: number,
): Promise<OwnedSubmissionListResponse> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (page !== undefined) params.set("page", String(page));
  if (perPage !== undefined) params.set("per_page", String(perPage));
  const query = params.toString();
  return workflowRequest(
    `/api/submissions/mine${query ? `?${query}` : ""}`,
    undefined,
    ownedSubmissionListResponseSchema,
  );
}

/** Resubmits a rejected submission using its existing draft contract. */
export async function resubmitSubmission(
  id: number,
): Promise<DraftResponse> {
  return workflowRequest(
    `/api/submissions/${id}/resubmit`,
    {
      method: "POST",
      headers: withCsrfToken(await workflowCsrf()),
    },
    draftResponseSchema,
  );
}
