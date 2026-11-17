"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";

import {
  federationAdminApi,
  type FederationProviderInput,
} from "../../lib/api/federation-admin";
import { publicApiPath } from "../../lib/api/origin";
import { federationQueryKeys } from "../../lib/api/query-keys";

type SensitiveActions = {
  request: (action: () => void, clear?: () => void) => void;
};

/** Owns provider-detail queries, mutations and cache invalidation. */
export function useProviderDetails(
  providerId: string,
  actions: SensitiveActions,
) {
  const queryClient = useQueryClient();
  const providerQuery = useQuery({
    queryKey: federationQueryKeys.provider(providerId),
    queryFn: () => federationAdminApi.getProvider(providerId),
    retry: false,
  });
  const statusQuery = useQuery({
    queryKey: federationQueryKeys.status(providerId),
    queryFn: () => federationAdminApi.getProviderStatus(providerId),
    retry: false,
  });
  const [editing, setEditing] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState<unknown>();
  const [secret, setSecret] = useState("");
  const [certificates, setCertificates] = useState("");
  const provider = statusQuery.data?.provider ?? providerQuery.data?.provider;

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: federationQueryKeys.provider(providerId),
    });
    void queryClient.invalidateQueries({
      queryKey: federationQueryKeys.status(providerId),
    });
    void queryClient.invalidateQueries({
      queryKey: federationQueryKeys.providers(),
    });
  };

  const mutation = useMutation({
    mutationFn: (
      input: Omit<FederationProviderInput, "provider_id" | "protocol" | "issuer">,
    ) => federationAdminApi.updateProvider(providerId, input),
    onSuccess: () => {
      setSuccess("Provider updated.");
      setEditing(false);
      refresh();
    },
  });
  const stateMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      enabled
        ? federationAdminApi.enableProvider(providerId)
        : federationAdminApi.disableProvider(providerId),
    onSuccess: () => {
      setSuccess("Provider state updated.");
      refresh();
    },
  });
  const rotateMutation = useMutation({
    mutationFn: (value: string) =>
      federationAdminApi.rotateSecret(providerId, value),
    onSuccess: () => {
      setSuccess(
        "Client secret rotated; pending transactions may have been invalidated.",
      );
      refresh();
    },
  });
  const certMutation = useMutation({
    mutationFn: (values: string[]) =>
      federationAdminApi.updateCertificates(providerId, values),
    onSuccess: () => {
      setSuccess("Trusted certificate set updated.");
      refresh();
    },
  });
  const revokeMutation = useMutation({
    mutationFn: () => federationAdminApi.revokeTransactions(providerId),
    onSuccess: (result) => {
      setSuccess(`${result.revoked} pending transaction(s) revoked.`);
      refresh();
    },
  });

  const publicOrigin = publicApiPath("/").replace(/\/$/, "");
  const canonicalRedirect = `${publicOrigin}/api/auth/oidc/${encodeURIComponent(
    providerId,
  )}/callback`;
  const canonicalAcs = `${publicOrigin}/api/auth/saml/${encodeURIComponent(
    providerId,
  )}/acs`;
  const sensitive = (action: () => void, clear?: () => void) => {
    setError(undefined);
    setSuccess("");
    actions.request(action, clear);
  };

  return {
    providerQuery,
    statusQuery,
    provider,
    editing,
    setEditing,
    success,
    error,
    setError,
    mutation,
    stateMutation,
    rotateMutation,
    certMutation,
    revokeMutation,
    secret,
    setSecret,
    certificates,
    setCertificates,
    publicOrigin,
    canonicalRedirect,
    canonicalAcs,
    sensitive,
  };
}
