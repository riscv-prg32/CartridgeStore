import { requestApiJson } from "../client";
import {
  federationProviderResponseSchema,
  federationProvidersResponseSchema,
  federationReauthResponseSchema,
  federationRevokeResponseSchema,
  federationSafeStatusResponseSchema,
} from "./schemas";
import type { FederationProviderInput } from "./types";
import { federationPath, mutate } from "./transport";

export function listProviders() {
  return requestApiJson(
    "/api/admin/federation/providers",
    undefined,
    federationProvidersResponseSchema,
  );
}

export function getProvider(providerId: string) {
  return requestApiJson(
    federationPath(
      `/api/admin/federation/providers/${encodeURIComponent(providerId)}`,
    ),
    undefined,
    federationProviderResponseSchema,
  );
}

export function getProviderStatus(providerId: string) {
  return requestApiJson(
    federationPath(
      `/api/admin/federation/providers/${encodeURIComponent(
        providerId,
      )}/status`,
    ),
    undefined,
    federationProviderResponseSchema,
  );
}

export function reauthenticate(password: string) {
  return mutate(
    "/api/admin/federation/reauthenticate",
    "POST",
    { password },
    federationReauthResponseSchema,
  );
}

export function createProvider(input: FederationProviderInput) {
  return mutate(
    "/api/admin/federation/providers",
    "POST",
    input,
    federationProviderResponseSchema,
  );
}

export function updateProvider(
  providerId: string,
  input: Omit<FederationProviderInput, "provider_id" | "protocol" | "issuer">,
) {
  return mutate(
    `/api/admin/federation/providers/${encodeURIComponent(providerId)}`,
    "PATCH",
    input,
    federationProviderResponseSchema,
  );
}

export function enableProvider(providerId: string) {
  return mutate(
    `/api/admin/federation/providers/${encodeURIComponent(
      providerId,
    )}/enable`,
    "POST",
    {},
    federationSafeStatusResponseSchema,
  );
}

export function disableProvider(providerId: string) {
  return mutate(
    `/api/admin/federation/providers/${encodeURIComponent(
      providerId,
    )}/disable`,
    "POST",
    {},
    federationSafeStatusResponseSchema,
  );
}

export function rotateSecret(providerId: string, secret: string) {
  return mutate(
    `/api/admin/federation/providers/${encodeURIComponent(
      providerId,
    )}/rotate-secret`,
    "POST",
    { purpose: "oidc-client-secret", secret },
    federationSafeStatusResponseSchema,
  );
}

export function updateCertificates(
  providerId: string,
  certificates: string[],
) {
  return mutate(
    `/api/admin/federation/providers/${encodeURIComponent(
      providerId,
    )}/certificates`,
    "POST",
    { certificates },
    federationSafeStatusResponseSchema,
  );
}

export function revokeTransactions(providerId: string) {
  return mutate(
    `/api/admin/federation/providers/${encodeURIComponent(
      providerId,
    )}/transactions/revoke`,
    "POST",
    {},
    federationRevokeResponseSchema,
  );
}
