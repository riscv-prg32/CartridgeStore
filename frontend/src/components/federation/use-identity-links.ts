"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";

import { federationAdminApi } from "../../lib/api/federation-admin";
import { federationQueryKeys } from "../../lib/api/query-keys";
import type { IdentityLinkFormState } from "./identity-link-types";

/** Owns identity-link queries, mutations and form state. */
export function useIdentityLinks() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: federationQueryKeys.identities(),
    queryFn: federationAdminApi.listIdentities,
    retry: false,
  });
  const providers = useQuery({
    queryKey: federationQueryKeys.providers(),
    queryFn: federationAdminApi.listProviders,
    retry: false,
  });
  const [form, setForm] = useState<IdentityLinkFormState>({
    protocol: "oidc" as "oidc" | "saml",
    provider_id: "",
    issuer: "",
    subject: "",
    user_id: "",
  });
  const [success, setSuccess] = useState("");
  const link = useMutation({
    mutationFn: () =>
      federationAdminApi.linkIdentity({
        ...form,
        user_id: Number(form.user_id),
      }),
    onSuccess: () => {
      setSuccess("Identity link created.");
      setForm((value) => ({ ...value, subject: "", user_id: "" }));
      void queryClient.invalidateQueries({
        queryKey: federationQueryKeys.identities(),
      });
    },
  });
  const retire = useMutation({
    mutationFn: (id: number) => federationAdminApi.retireIdentity(id),
    onSuccess: () => {
      setSuccess("Identity link retired.");
      void queryClient.invalidateQueries({
        queryKey: federationQueryKeys.identities(),
      });
    },
  });
  const selectedProvider = providers.data?.providers.find(
    (provider) => provider.provider_id === form.provider_id,
  );

  return {
    query,
    providers,
    form,
    setForm,
    success,
    link,
    retire,
    selectedProvider,
  };
}
