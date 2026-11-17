import { requestApiJson, withCsrfToken } from "../client";
import {
  authLogoutResponseSchema,
  authTokenCreatedResponseSchema,
  authTokenUpdatedResponseSchema,
  authTokensResponseSchema,
} from "../schemas";
import { authPath, getAuthCsrf } from "./transport";

/** Lists API tokens belonging to the current user. */
export function getAuthTokens() {
  return requestApiJson(
    authPath("/auth/tokens"),
    undefined,
    authTokensResponseSchema,
  );
}

/** Creates an API token with the supplied label. */
export async function createAuthToken(label: string) {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/tokens"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ label }),
    },
    authTokenCreatedResponseSchema,
  );
}

/** Renames an API token. */
export async function updateAuthToken(id: number, label: string) {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath(`/auth/tokens/${encodeURIComponent(String(id))}`),
    {
      method: "PATCH",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ label }),
    },
    authTokenUpdatedResponseSchema,
  );
}

/** Revokes an API token. */
export async function revokeAuthToken(id: number) {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath(`/auth/tokens/${encodeURIComponent(String(id))}`),
    {
      method: "DELETE",
      headers: withCsrfToken(csrf.csrf_token),
    },
    authLogoutResponseSchema,
  );
}
