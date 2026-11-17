import { ApiRequestError } from "../client";
import { WorkflowIntegrationUnavailableError } from "./transport";

/** Converts workflow failures into user-facing messages. */
export function workflowErrorMessage(error: unknown): string {
  if (error instanceof WorkflowIntegrationUnavailableError) {
    return "The isolated publishing and review service is not configured or is unavailable.";
  }
  if (error instanceof ApiRequestError) {
    if (error.status === 401) {
      return "Sign in is required for this workflow.";
    }
    if (error.status === 403 && error.body?.code === "csrf_failed") {
      return "Your session expired. Refresh and try again.";
    }
    if (error.status === 403) {
      return "You are not authorized for this workflow.";
    }
    if (error.status === 404) {
      return "The requested submission was not found.";
    }
    if (error.status === 409) {
      return "The submission changed state. Refresh before trying again.";
    }
    if (error.status === 413) {
      return "The bundle is too large for the publishing service.";
    }
    if (error.status >= 500) {
      return "The publishing and review service is temporarily unavailable.";
    }
  }
  if (error instanceof TypeError) {
    return "The publishing and review service could not be reached.";
  }
  return "The workflow request could not be completed.";
}
