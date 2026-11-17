import {
  requestApiJson,
  withCsrfToken,
} from "../client";
import type {
  AuthLogoutResponse,
  AuthOperationResponse,
  AuthProfileResponse,
  AuthUserResponse,
} from "../contracts";
import {
  authLogoutResponseSchema,
  authOperationResponseSchema,
  authProfileResponseSchema,
  authUserResponseSchema,
} from "../schemas";
import { authPath, getAuthCsrf } from "./transport";

/** Reads the currently authenticated principal. */
export function getCurrentUser(): Promise<AuthUserResponse> {
  return requestApiJson(
    authPath("/auth/me"),
    undefined,
    authUserResponseSchema,
  );
}

/** Updates the human-readable name shown in the account UI. */
export async function updateProfile(
  displayName: string,
): Promise<AuthProfileResponse> {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/profile"),
    {
      method: "PATCH",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ display_name: displayName }),
    },
    authProfileResponseSchema,
  );
}

/** Authenticates a local user with the existing password contract. */
export async function loginWithPassword(
  username: string,
  password: string,
): Promise<AuthUserResponse> {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/login"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ username, password }),
    },
    authUserResponseSchema,
  );
}

/** Ends the current local authentication session. */
export async function logoutLocal(): Promise<AuthLogoutResponse> {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/logout"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token),
    },
    authLogoutResponseSchema,
  );
}

/** Changes the authenticated user's password. */
export async function changePassword(
  currentPassword: string,
  password: string,
  passwordConfirm: string,
): Promise<AuthOperationResponse> {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/password/change"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        current_password: currentPassword,
        password,
        password_confirm: passwordConfirm,
      }),
    },
    authOperationResponseSchema,
  );
}

/** Reauthenticates the current user for sensitive actions. */
export async function reauthenticate(
  password: string,
): Promise<AuthOperationResponse> {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/reauthenticate"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ password }),
    },
    authOperationResponseSchema,
  );
}
