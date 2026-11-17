import type { ZodType } from "zod";

import { ApiRequestError, requestApiJson } from "../client";
import { csrfResponseSchema } from "../schemas";

/** Signals that the Fastify workflow backend is unavailable. */
export class WorkflowIntegrationUnavailableError extends Error {
  constructor(
    message =
      "The Fastify publishing and review integration is unavailable.",
  ) {
    super(message);
    this.name = "WorkflowIntegrationUnavailableError";
  }
}

/** Builds a validated path below the public API origin. */
export function workflowPath(path: string): string {
  const pathname = path.split("?", 1)[0] ?? "";
  if (
    !pathname.startsWith("/") ||
    pathname.includes("//") ||
    pathname.includes("..")
  ) {
    throw new Error("Invalid workflow API path");
  }
  return path;
}

/** Executes a validated workflow request and maps missing proxy failures. */
export async function workflowRequest<T>(
  path: string,
  init?: RequestInit,
  schema?: ZodType<T>,
): Promise<T> {
  try {
    return await requestApiJson(workflowPath(path), init, schema);
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      [404, 502, 503].includes(error.status) &&
      !error.body
    ) {
      throw new WorkflowIntegrationUnavailableError();
    }
    throw error;
  }
}

let csrfToken: string | null = null;

/** Clears cached workflow session state. */
export function clearWorkflowSessionState(): void {
  csrfToken = null;
}

/** Returns the cached workflow CSRF token, fetching it once per session. */
export async function workflowCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await workflowRequest(
    "/auth/csrf",
    undefined,
    csrfResponseSchema,
  );
  csrfToken = response.csrf_token;
  return csrfToken;
}

/** Invalidates the cached workflow CSRF token after a rejected mutation. */
export function invalidateWorkflowCsrf(): void {
  csrfToken = null;
}
