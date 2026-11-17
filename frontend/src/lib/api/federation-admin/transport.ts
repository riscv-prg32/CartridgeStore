import { z } from "zod";

import { requestApiJson, withCsrfToken } from "../client";

/** Validates paths below the federation administration API. */
export function federationPath(path: string): string {
  if (
    !path.startsWith("/api/admin/federation/") ||
    path.includes("//") ||
    path.includes("..")
  ) {
    throw new Error("Invalid federation administration API path");
  }
  return path;
}

async function mutationHeaders(): Promise<Headers> {
  const csrf = await requestApiJson(
    "/auth/csrf",
    undefined,
    z.object({
      ok: z.literal(true),
      csrf_token: z.string().min(32),
    }),
  );
  return withCsrfToken(csrf.csrf_token, {
    "content-type": "application/json",
  });
}

/** Executes a JSON federation mutation with the existing CSRF contract. */
export async function mutate<T>(
  path: string,
  method: "POST" | "PATCH",
  payload: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const headers = await mutationHeaders();
  return requestApiJson(
    federationPath(path),
    {
      method,
      headers,
      body: JSON.stringify(payload),
    },
    schema,
  );
}
