import { requestApiJson, withCsrfToken } from "../client";
import {
  authUserResponseSchema,
  passkeyMutationResponseSchema,
  passkeyOptionsResponseSchema,
  passkeysResponseSchema,
} from "../schemas";
import { authPath, getAuthCsrf } from "./transport";

/** Lists passkeys registered for the current user. */
export function getPasskeys() {
  return requestApiJson(
    authPath("/auth/passkeys"),
    undefined,
    passkeysResponseSchema,
  );
}

/** Starts passkey registration. */
export async function beginPasskeyRegistration() {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/passkeys/register/options"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: "{}",
    },
    passkeyOptionsResponseSchema,
  );
}

/** Completes passkey registration. */
export async function finishPasskeyRegistration(
  response: unknown,
  displayName: string,
) {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/passkeys/register"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ response, display_name: displayName }),
    },
    passkeyMutationResponseSchema,
  );
}

/** Starts passkey login, optionally scoped to a username. */
export async function beginPasskeyLogin(username = "") {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/passkeys/login/options"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify(
        username.trim() ? { username: username.trim() } : {},
      ),
    },
    passkeyOptionsResponseSchema,
  );
}

/** Completes passkey login. */
export async function finishPasskeyLogin(response: unknown) {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath("/auth/passkeys/login"),
    {
      method: "POST",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ response }),
    },
    authUserResponseSchema,
  );
}

/** Renames a registered passkey. */
export async function renamePasskey(id: string, displayName: string) {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath(`/auth/passkeys/${encodeURIComponent(id)}`),
    {
      method: "PATCH",
      headers: withCsrfToken(csrf.csrf_token, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ display_name: displayName }),
    },
    passkeyMutationResponseSchema,
  );
}

/** Revokes a registered passkey. */
export async function revokePasskey(id: string) {
  const csrf = await getAuthCsrf();
  return requestApiJson(
    authPath(`/auth/passkeys/${encodeURIComponent(id)}`),
    {
      method: "DELETE",
      headers: withCsrfToken(csrf.csrf_token),
    },
    passkeyMutationResponseSchema,
  );
}
