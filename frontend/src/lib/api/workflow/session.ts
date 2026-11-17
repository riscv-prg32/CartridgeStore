import type { AuthUserResponse } from "../contracts";
import { authUserResponseSchema } from "../schemas";
import { workflowRequest } from "./transport";

/** Reads the authenticated principal for workflow authorization. */
export function getWorkflowPrincipal(): Promise<AuthUserResponse> {
  return workflowRequest("/auth/me", undefined, authUserResponseSchema);
}
