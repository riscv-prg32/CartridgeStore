import { requestApiJson } from "../client";
import { csrfResponseSchema } from "../schemas";

/** Builds a validated path for the authentication API. */
export function authPath(path: string): string {
  if (!path.startsWith("/") || path.includes("//") || path.includes("..")) {
    throw new Error("Invalid authentication API path");
  }

  return path;
}

/** Reads the CSRF token required by authentication mutations. */
export function getAuthCsrf(): Promise<{
  ok: true;
  csrf_token: string;
}> {
  return requestApiJson(
    authPath("/auth/csrf"),
    undefined,
    csrfResponseSchema,
  );
}
