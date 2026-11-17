import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminApi } from "../../../lib/api/admin";
import { adminQueryKeys } from "../../../lib/api/query-keys";

export function useAdminTokens() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: adminQueryKeys.tokens({ page: 1 }), queryFn: () => adminApi.listTokens({ page: 1, limit: 100 }), retry: false });
  const revoke = useMutation({ mutationFn: (id: number) => adminApi.revokeToken(id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminQueryKeys.tokensRoot() }) });
  return { query, revoke };
}
