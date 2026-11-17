import { requestApiJson, withCsrfToken } from "../client";
import type { AuthOperationResponse } from "../contracts";
import { authOperationResponseSchema } from "../schemas";
import { authPath, getAuthCsrf } from "./transport";

/** Requests a password reset email or equivalent recovery flow. */
export async function requestPasswordReset(
  identifier: string,
): Promise<AuthOperationResponse> {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/password/reset/request"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ identifier }),
    },
    authOperationResponseSchema,
  );
}

/** Completes a password reset with a recovery token. */
export async function completePasswordReset(
  token: string,
  password: string,
  passwordConfirm: string,
): Promise<AuthOperationResponse> {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/password/reset/complete"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        token,
        password,
        password_confirm: passwordConfirm,
      }),
    },
    authOperationResponseSchema,
  );
}
