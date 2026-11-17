import { requestApiJson } from "../client";
import type { AuthProvider, AuthProvidersResponse } from "../contracts";
import { authProvidersResponseSchema } from "../schemas";
import { publicApiPath } from "../origin";
import { safeReturnPath } from "../../auth/return-path";
import { authPath } from "./transport";

/** Lists enabled federated authentication providers. */
export function getAuthProviders(): Promise<AuthProvidersResponse> {
  return requestApiJson(
    publicApiPath(authPath("/api/auth/providers")),
    undefined,
    authProvidersResponseSchema,
  );
}

/** Builds a safe browser navigation URL for a federated provider. */
export function federatedLoginUrl(
  provider: AuthProvider,
  returnTo: string | null | undefined,
): string {
  const safePath = safeReturnPath(returnTo);
  const protocolPath = provider.protocol === "oidc" ? "oidc" : "saml";
  return `${publicApiPath(
    authPath(
      `/api/auth/${protocolPath}/${encodeURIComponent(
        provider.provider_id,
      )}/login`,
    ),
  )}?return_to=${encodeURIComponent(safePath)}`;
}
