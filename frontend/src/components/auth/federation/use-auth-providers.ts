"use client";

import { useQuery } from "@tanstack/react-query";

import { getAuthProviders } from "../../../lib/api/auth";
import { authQueryKeys } from "../../../lib/api/query-keys";

export function useAuthProviders(enabled: boolean) {
  return useQuery({
    queryKey: authQueryKeys.providers(),
    queryFn: getAuthProviders,
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}
