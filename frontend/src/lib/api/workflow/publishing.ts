import { ApiRequestError, withCsrfToken } from "../client";
import type { WorkflowSubmissionResult } from "../contracts";
import { workflowSubmissionResultSchema } from "../schemas";
import {
  invalidateWorkflowCsrf,
  workflowCsrf,
  workflowRequest,
} from "./transport";

/** Uploads a cartridge bundle through the publishing workflow. */
export async function submitBundle(
  file: File,
): Promise<WorkflowSubmissionResult> {
  const form = new FormData();
  form.set("bundle", file, file.name);
  try {
    return await workflowRequest(
      "/api/publish/bundle",
      {
        method: "POST",
        headers: withCsrfToken(await workflowCsrf()),
        body: form,
      },
      workflowSubmissionResultSchema,
    );
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      error.status === 403 &&
      error.body?.code === "csrf_failed"
    ) {
      invalidateWorkflowCsrf();
    }
    throw error;
  }
}
