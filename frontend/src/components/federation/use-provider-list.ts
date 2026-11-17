"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { federationAdminApi } from "../../lib/api/federation-admin";
import { federationQueryKeys } from "../../lib/api/query-keys";

/** Owns provider-list queries, state mutation and cache invalidation. */
export function useProviderList() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: federationQueryKeys.providers(),
    queryFn: federationAdminApi.listProviders,
    retry: false,
  });
  const [success, setSuccess] = useState("");
  const mutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled
        ? federationAdminApi.enableProvider(id)
        : federationAdminApi.disableProvider(id),
    onSuccess: () => {
      setSuccess("Provider state updated.");
      void queryClient.invalidateQueries({
        queryKey: federationQueryKeys.providers(),
      });
    },
  });

  return { query, mutation, success, setSuccess };
}
