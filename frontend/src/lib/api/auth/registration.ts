import { requestApiJson, withCsrfToken } from "../client";
import type { AuthUserResponse } from "../contracts";
import {
  authUserResponseSchema,
  registrationRequestedResponseSchema,
} from "../schemas";
import { authPath, getAuthCsrf } from "./transport";

/** Starts registration using the existing email verification contract. */
export async function requestRegistration(
  username: string,
  email: string,
  password: string,
  passwordConfirm: string,
) {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/register"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        username,
        email,
        password,
        password_confirm: passwordConfirm,
      }),
    },
    registrationRequestedResponseSchema,
  );
}

/** Completes registration with a verification token. */
export async function completeRegistration(
  token: string,
  password = "",
  passwordConfirm = "",
): Promise<AuthUserResponse> {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/register/complete"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        token,
        ...(password
          ? { password, password_confirm: passwordConfirm }
          : {}),
      }),
    },
    authUserResponseSchema,
  );
}
