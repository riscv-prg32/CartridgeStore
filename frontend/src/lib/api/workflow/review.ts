import { withCsrfToken } from "../client";
import type { WorkflowSubmissionResponse } from "../contracts";
import { workflowSubmissionResponseSchema } from "../schemas";
import { workflowCsrf, workflowRequest } from "./transport";

/** Approves a submission with reviewer metadata and note. */
export async function approveSubmission(
  id: number,
  metadata: Record<string, unknown>,
  note = "",
): Promise<WorkflowSubmissionResponse> {
  return workflowRequest(
    `/api/submissions/${id}/verify`,
    {
      method: "POST",
      headers: withCsrfToken(await workflowCsrf(), {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ metadata, note }),
    },
    workflowSubmissionResponseSchema,
  );
}

/** Rejects a submission with an optional reviewer note. */
export async function rejectSubmission(
  id: number,
  note = "",
): Promise<WorkflowSubmissionResponse> {
  return workflowRequest(
    `/api/submissions/${id}/reject`,
    {
      method: "POST",
      headers: withCsrfToken(await workflowCsrf(), {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ note }),
    },
    workflowSubmissionResponseSchema,
  );
}
