import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { createAuthToken, getAuthTokens, revokeAuthToken, updateAuthToken } from "../../../lib/api/auth";
import { authQueryKeys } from "../../../lib/api/query-keys";

export function useApiTokens() {
  const queryClient = useQueryClient();
  const [newToken, setNewToken] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const tokens = useQuery({ queryKey: authQueryKeys.tokens(), queryFn: getAuthTokens, retry: false });
  const create = useMutation({
    mutationFn: async (label: string) => {
      const result = await createAuthToken(label);
      if (mountedRef.current) setNewToken(result.token);
    },
    retry: false,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: authQueryKeys.tokens() }),
  });
  const revoke = useMutation({ mutationFn: (id: number) => revokeAuthToken(id), retry: false, onSuccess: () => void queryClient.invalidateQueries({ queryKey: authQueryKeys.tokens() }) });
  const rename = useMutation({ mutationFn: ({ id, nextLabel }: { id: number; nextLabel: string }) => updateAuthToken(id, nextLabel), retry: false, onSuccess: () => void queryClient.invalidateQueries({ queryKey: authQueryKeys.tokens() }) });
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  return { tokens, create, revoke, rename, newToken, dismissNewToken: () => setNewToken(null) };
}
