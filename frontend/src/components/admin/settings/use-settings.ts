import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminApi } from "../../../lib/api/admin";
import { adminQueryKeys } from "../../../lib/api/query-keys";

export function useAdminSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: adminQueryKeys.settings(), queryFn: adminApi.getSettings, retry: false });
  const update = useMutation({ mutationFn: (patch: Record<string, unknown>) => adminApi.updateSettings(patch), onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminQueryKeys.settings() }) });
  const testConnection = useMutation({ mutationFn: adminApi.testSmtpConnection });
  const sendTestMessage = useMutation({ mutationFn: (recipient: string) => adminApi.sendSmtpTestMessage(recipient) });
  const uploadAsset = useMutation({ mutationFn: ({ kind, file }: { kind: "logo" | "favicon"; file: File }) => adminApi.uploadAsset(kind, file), onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminQueryKeys.settings() }) });
  const deleteAsset = useMutation({ mutationFn: (kind: "logo" | "favicon") => adminApi.deleteAsset(kind), onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminQueryKeys.settings() }) });
  return { query, update, testConnection, sendTestMessage, uploadAsset, deleteAsset };
}
