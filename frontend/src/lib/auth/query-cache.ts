import type { QueryClient } from "@tanstack/react-query";

import { adminQueryKeys, authQueryKeys, federationQueryKeys, metricsQueryKeys, workflowQueryKeys } from "../api/query-keys";

/** Remove authenticated response data when the browser session changes user. */
export function removeSensitiveQueryData(queryClient: QueryClient): void {
  for (const queryKey of [
    authQueryKeys.all,
    workflowQueryKeys.all,
    adminQueryKeys.all,
    federationQueryKeys.all,
    metricsQueryKeys.all,
    ["profile"],
  ]) {
    queryClient.removeQueries({ queryKey });
  }
}
