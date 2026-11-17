"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { ApiRequestError } from "../api/client";
import { getCurrentUser } from "../api/auth";
import { authQueryKeys } from "../api/query-keys";
import { authIntegrationEnabled } from "./config";
import { removeSensitiveQueryData } from "./query-cache";

async function currentUserOrAnonymous() {
  try {
    return await getCurrentUser();
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return null;
    throw error;
  }
}

export function useCurrentUser(enabled = authIntegrationEnabled) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: authQueryKeys.currentUser(),
    queryFn: currentUserOrAnonymous,
    enabled,
    retry: false,
    // An anonymous response is a valid session state, not a transient error.
    // Keep it stable while browsing public pages; login/logout explicitly
    // invalidates this query when the session can actually change.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (enabled && query.isFetched && query.data === null) {
      removeSensitiveQueryData(queryClient);
    }
  }, [enabled, query.data, query.isFetched, queryClient]);

  return {
    ...query,
    user: query.data?.user ?? null,
  };
}

export function useAuthQueryClient() {
  return useQueryClient();
}
